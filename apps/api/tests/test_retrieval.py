"""
tests/test_retrieval.py — cosine retrieval and the `knowledge_search` tool node.

Two halves, split by what they can prove:

- **Integration**, against the real test database with real pgvector columns and
  the real HNSW index. Only the embedding call is faked. Ranking, the tenant
  join and the score floor are all things a mock cannot honestly assert — the
  join in particular is the ONLY isolation `document_chunks` has, so it must be
  exercised against a real query planner rather than a stub.
- **Unit**, over the tool node's config validation and its state handling, where
  no database is involved at all.

The vectors are deliberately axis-aligned unit vectors, so cosine similarity is
exactly 1.0 for a match and 0.0 for a miss. That makes every ranking and floor
assertion an exact equality instead of a tolerance, and a regression in the
ordering direction (a very easy sign error) fails loudly rather than marginally.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from src.core.llm_client import EmbeddingResult
from src.graphs.node_handlers import ToolNodeConfigError, tool_handler
from src.modules.knowledge_base.models import Document, DocumentChunk
from src.modules.knowledge_base.service import RRF_K, RetrievalHit, RetrievalResult, fuse_hybrid

DIMENSIONS = 1536


def _axis_vector(axis: int) -> list[float]:
    """A unit vector along one axis — cosine 1.0 with itself, 0.0 with any other."""
    vector = [0.0] * DIMENSIONS
    vector[axis] = 1.0
    return vector


class FakeEmbedder:
    """Embeds any query to a fixed axis vector. Records the model it was asked for."""

    def __init__(self, axis: int = 0, tokens: int = 7, cost_usd: float = 0.00000014):
        self.axis = axis
        self.tokens = tokens
        self.cost_usd = cost_usd
        self.calls: list[tuple[list[str], str]] = []

    def embed(self, *, texts, model):
        self.calls.append((list(texts), model))
        return EmbeddingResult(
            vectors=[_axis_vector(self.axis) for _ in texts],
            model=model,
            dimensions=DIMENSIONS,
            tokens=self.tokens,
            cost_usd=self.cost_usd,
        )


def _factory(embedder: FakeEmbedder):
    return lambda *a, **kw: embedder


# ---------------------------------------------------------------------------
# Fixtures — a real KB with real vectors in it
# ---------------------------------------------------------------------------


async def _tenant_with_corpus(
    client: AsyncClient,
    session,
    slug: str,
    *,
    embedding_model: str = "text-embedding-3-small",
) -> tuple[dict, str]:
    """
    Register an org, create a KB, and write two chunks with known vectors.

    Chunk 0 sits on axis 0 ("the AP clause"), chunk 1 on axis 1 ("unrelated").
    A query embedded on axis 0 therefore scores exactly 1.0 and 0.0.
    """
    from test_workflow_versions import register_and_get_token
    from test_workflows import create_workspace

    data = await register_and_get_token(client, f"{slug}-{uuid.uuid4().hex[:6]}")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    workspace = await create_workspace(client, data["access_token"])

    kb_response = await client.post(
        "/api/v1/knowledge-bases",
        json={"workspace_id": workspace["id"], "name": "Policies", "embedding_model": embedding_model},
        headers=headers,
    )
    assert kb_response.status_code == 201, kb_response.text
    kb = kb_response.json()

    document = Document(
        organization_id=uuid.UUID(kb["organization_id"]),
        knowledge_base_id=uuid.UUID(kb["id"]),
        file_name="ap-policy.pdf",
        storage_path=f"{kb['organization_id']}/{kb['id']}/doc/ap-policy.pdf",
        mime_type="application/pdf",
        status="indexed",
    )
    session.add(document)
    await session.flush()

    session.add_all(
        [
            DocumentChunk(
                document_id=document.id,
                chunk_index=0,
                content="Invoices at or above USD 5,000 require the finance controller's approval.",
                token_count=13,
                embedding=_axis_vector(0),
            ),
            DocumentChunk(
                document_id=document.id,
                chunk_index=1,
                content="The office kitchen is restocked on Tuesdays.",
                token_count=8,
                embedding=_axis_vector(1),
            ),
        ]
    )
    await session.commit()
    return headers, kb["id"]


# ---------------------------------------------------------------------------
# Retrieval — the search endpoint
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_search_ranks_the_semantically_closest_chunk_first(client: AsyncClient, session, monkeypatch):
    """The whole point: a real cosine query over a real HNSW index, ordered correctly."""
    headers, kb_id = await _tenant_with_corpus(client, session, "rank")
    embedder = FakeEmbedder(axis=0)
    monkeypatch.setattr("src.modules.knowledge_base.service.get_llm_client", _factory(embedder))

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb_id}/search",
        json={"query": "when does an invoice need approval?", "score_floor": 0.0},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["hit_count"] == 2
    assert [hit["chunk_index"] for hit in body["hits"]] == [0, 1], "best match must come first"
    assert body["hits"][0]["score"] == pytest.approx(1.0)
    assert body["hits"][1]["score"] == pytest.approx(0.0)
    # The citation an agent needs.
    assert body["hits"][0]["document_name"] == "ap-policy.pdf"


@pytest.mark.asyncio
async def test_the_score_floor_drops_weak_matches(client: AsyncClient, session, monkeypatch):
    headers, kb_id = await _tenant_with_corpus(client, session, "floor")
    monkeypatch.setattr("src.modules.knowledge_base.service.get_llm_client", _factory(FakeEmbedder(axis=0)))

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb_id}/search",
        json={"query": "invoice approval threshold", "score_floor": 0.3},
        headers=headers,
    )

    body = response.json()
    assert body["hit_count"] == 1, "the 0.0-similarity chunk must not survive the floor"
    assert body["hits"][0]["chunk_index"] == 0


@pytest.mark.asyncio
async def test_the_query_is_embedded_with_the_kbs_own_model(client: AsyncClient, session, monkeypatch):
    """
    Cross-model cosine returns plausible numbers and meaningless rankings, and
    raises nowhere. The KB row is the authority, not a settings default.
    """
    headers, kb_id = await _tenant_with_corpus(client, session, "model", embedding_model="text-embedding-3-large")
    embedder = FakeEmbedder(axis=0)
    monkeypatch.setattr("src.modules.knowledge_base.service.get_llm_client", _factory(embedder))

    await client.post(
        f"/api/v1/knowledge-bases/{kb_id}/search",
        json={"query": "anything"},
        headers=headers,
    )

    assert [model for _texts, model in embedder.calls] == ["text-embedding-3-large"]


@pytest.mark.asyncio
async def test_an_empty_knowledge_base_returns_no_hits_rather_than_raising(client: AsyncClient, monkeypatch):
    """Called out by name in the 15-day plan. An unpopulated KB is a normal state."""
    from test_workflow_versions import register_and_get_token
    from test_workflows import create_workspace

    data = await register_and_get_token(client, f"empty-{uuid.uuid4().hex[:6]}")
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    workspace = await create_workspace(client, data["access_token"])
    kb = await client.post(
        "/api/v1/knowledge-bases",
        json={"workspace_id": workspace["id"], "name": "Nothing here yet"},
        headers=headers,
    )
    monkeypatch.setattr("src.modules.knowledge_base.service.get_llm_client", _factory(FakeEmbedder()))

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb.json()['id']}/search",
        json={"query": "what is the policy?"},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    assert response.json()["hits"] == []
    assert response.json()["hit_count"] == 0


@pytest.mark.asyncio
async def test_a_blank_query_is_rejected_before_anything_is_billed(client: AsyncClient, session, monkeypatch):
    headers, kb_id = await _tenant_with_corpus(client, session, "blank")
    embedder = FakeEmbedder()
    monkeypatch.setattr("src.modules.knowledge_base.service.get_llm_client", _factory(embedder))

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb_id}/search",
        json={"query": "   "},
        headers=headers,
    )

    assert response.status_code == 422
    assert embedder.calls == [], "whitespace must never reach a billable embedding call"


@pytest.mark.asyncio
async def test_search_results_are_isolated_between_orgs(client: AsyncClient, session, monkeypatch):
    """
    `document_chunks` has no `organization_id` and no RLS policy. The join
    through `documents` in `build_chunk_search_stmt` is the only thing stopping
    a cosine query from ranking over every tenant's corpus at once.
    """
    monkeypatch.setattr("src.modules.knowledge_base.service.get_llm_client", _factory(FakeEmbedder(axis=0)))
    headers_a, kb_a = await _tenant_with_corpus(client, session, "org-a")
    headers_b, kb_b = await _tenant_with_corpus(client, session, "org-b")

    # Org B searches its own KB: it must see only its own two chunks, never the
    # four that now exist across both orgs.
    response = await client.post(
        f"/api/v1/knowledge-bases/{kb_b}/search",
        json={"query": "invoice approval", "score_floor": 0.0},
        headers=headers_b,
    )
    assert response.status_code == 200
    assert response.json()["hit_count"] == 2

    total = len((await session.execute(select(DocumentChunk))).scalars().all())
    assert total == 4, "both corpora must actually be present, or this proves nothing"


@pytest.mark.asyncio
async def test_searching_another_orgs_knowledge_base_is_404(client: AsyncClient, session, monkeypatch):
    monkeypatch.setattr("src.modules.knowledge_base.service.get_llm_client", _factory(FakeEmbedder()))
    headers_a, kb_a = await _tenant_with_corpus(client, session, "victim")
    headers_b, _kb_b = await _tenant_with_corpus(client, session, "attacker")

    response = await client.post(
        f"/api/v1/knowledge-bases/{kb_a}/search",
        json={"query": "give me their policies"},
        headers=headers_b,
    )

    assert response.status_code == 404, "never 403 — confirming the KB exists is itself a leak"


# ---------------------------------------------------------------------------
# The `knowledge_search` tool node
# ---------------------------------------------------------------------------


def _fake_search(**expected):
    """A stand-in for `search_knowledge_base_sync` that records its kwargs."""
    calls: list[dict] = []

    def search(**kwargs):
        calls.append(kwargs)
        return RetrievalResult(
            hits=[
                RetrievalHit(
                    document_id=uuid.uuid4(),
                    document_name="ap-policy.pdf",
                    chunk_index=0,
                    content="Invoices at or above USD 5,000 require approval.",
                    score=0.82,
                )
            ],
            model="text-embedding-3-small",
            tokens=9,
            cost_usd=0.00000018,
        )

    search.calls = calls
    return search


ORG_ID = str(uuid.uuid4())
KB_ID = str(uuid.uuid4())


def _state(**extra):
    return {"organization_id": ORG_ID, "node_outputs": {}, "node_usage": {}, **extra}


def test_knowledge_search_node_writes_hits_and_citations_into_state():
    search = _fake_search()
    update = tool_handler(
        _state(),
        node_key="find_policy",
        config={"tool_type": "knowledge_search", "knowledge_base_id": KB_ID, "query": "approval threshold"},
        search=search,
    )

    output = update["node_outputs"]["find_policy"]
    assert output["hit_count"] == 1
    assert output["hits"][0]["document_name"] == "ap-policy.pdf"
    assert output["hits"][0]["chunk_index"] == 0
    assert "content" in output["hits"][0]


def test_knowledge_search_node_reports_its_embedding_cost():
    """
    The deliberate break with `http_request`/`erp_connector`, which emit no
    usage. Retrieval embeds the query, so a silent NULL here would make every
    RAG run under-report its own spend.
    """
    update = tool_handler(
        _state(current_cost_usd=0.5),
        node_key="find_policy",
        config={"tool_type": "knowledge_search", "knowledge_base_id": KB_ID, "query": "x"},
        search=_fake_search(),
    )

    usage = update["node_usage"]["find_policy"]
    assert usage["tokens_prompt"] == 9
    assert usage["tokens_completion"] == 0
    assert usage["cost_usd"] == pytest.approx(0.00000018)
    assert update["current_cost_usd"] == pytest.approx(0.5 + 0.00000018)


def test_the_organization_comes_from_state_not_from_node_config():
    """
    Node config is author-supplied text on a canvas; graph state is seeded from
    the run row. An `organization_id` in config must be ignored outright.
    """
    search = _fake_search()
    other_org = str(uuid.uuid4())
    tool_handler(
        _state(),
        node_key="find_policy",
        config={
            "tool_type": "knowledge_search",
            "knowledge_base_id": KB_ID,
            "query": "x",
            "organization_id": other_org,
        },
        search=search,
    )

    assert str(search.calls[0]["organization_id"]) == ORG_ID
    assert str(search.calls[0]["organization_id"]) != other_org


def test_a_missing_organization_in_state_fails_rather_than_searching_everything():
    with pytest.raises(ToolNodeConfigError, match="organization_id"):
        tool_handler(
            {"node_outputs": {}},
            node_key="find_policy",
            config={"tool_type": "knowledge_search", "knowledge_base_id": KB_ID, "query": "x"},
            search=_fake_search(),
        )


def test_the_query_is_resolved_from_graph_state_when_wired():
    search = _fake_search()
    state = _state(node_outputs={"extract": {"description": "software licence renewal"}})
    tool_handler(
        state,
        node_key="find_policy",
        config={
            "tool_type": "knowledge_search",
            "knowledge_base_id": KB_ID,
            "query": "fallback typed while wiring",
            "query_fields": {"query": "node_outputs.extract.description"},
        },
        search=search,
    )

    assert search.calls[0]["query"] == "software licence renewal", "the live value must beat the static fallback"


def test_a_node_with_neither_query_nor_query_fields_is_rejected():
    with pytest.raises(ToolNodeConfigError, match="query"):
        tool_handler(
            _state(),
            node_key="find_policy",
            config={"tool_type": "knowledge_search", "knowledge_base_id": KB_ID},
            search=_fake_search(),
        )


def test_a_malformed_knowledge_base_id_is_rejected_at_config_time():
    with pytest.raises(ToolNodeConfigError, match="knowledge_base_id"):
        tool_handler(
            _state(),
            node_key="find_policy",
            config={"tool_type": "knowledge_search", "knowledge_base_id": "not-a-uuid", "query": "x"},
            search=_fake_search(),
        )


def test_retrieval_may_not_declare_itself_mutating():
    """
    A read that demands an approval gate upstream devalues the gate. The
    guardrail only means something while every node it fires on really writes.
    """
    with pytest.raises(ToolNodeConfigError, match="read-only"):
        tool_handler(
            _state(),
            node_key="find_policy",
            config={
                "tool_type": "knowledge_search",
                "knowledge_base_id": KB_ID,
                "query": "x",
                "is_mutating": True,
            },
            search=_fake_search(),
        )


def test_no_hits_is_a_result_not_a_failure():
    """An unanswerable question must reach the agent as an empty list, so it can say so."""

    def empty_search(**kwargs):
        return RetrievalResult(hits=[], model="text-embedding-3-small", tokens=5, cost_usd=0.0)

    update = tool_handler(
        _state(),
        node_key="find_policy",
        config={"tool_type": "knowledge_search", "knowledge_base_id": KB_ID, "query": "unrelated"},
        search=empty_search,
    )

    assert update["node_outputs"]["find_policy"] == {"query": "unrelated", "hit_count": 0, "hits": []}


def test_a_knowledge_base_outside_the_org_surfaces_as_a_config_error():
    def missing_kb(**kwargs):
        raise LookupError("nope")

    with pytest.raises(ToolNodeConfigError, match="does not exist in this organization"):
        tool_handler(
            _state(),
            node_key="find_policy",
            config={"tool_type": "knowledge_search", "knowledge_base_id": KB_ID, "query": "x"},
            search=missing_kb,
        )


def test_the_audit_snapshot_carries_no_resolved_query():
    """
    `tool_executions.input` is the intent row, written before the call. The
    resolved query is state-derived and lands in `output` instead — same rule
    that keeps request bodies out of the intent snapshot.
    """
    from src.graphs.node_handlers import _audit_input, _tool_config

    cfg = _tool_config(
        {
            "tool_type": "knowledge_search",
            "knowledge_base_id": KB_ID,
            "query_fields": {"query": "node_outputs.extract.description"},
        },
        "find_policy",
    )
    snapshot = _audit_input(cfg)

    assert snapshot["knowledge_base_id"] == KB_ID
    assert "query" not in snapshot
    assert snapshot["is_mutating"] is False


def test_a_node_cannot_repoint_a_registry_retrieval_tool_at_another_corpus():
    """
    `knowledge_base_id` is the retrieval target — the analogue of `url`, and
    registry-owned for the same reason. Only the question is per-usage.
    """
    from src.modules.tools.service import ToolService

    assert "query" in ToolService.NODE_OVERRIDABLE_KEYS
    assert "query_fields" in ToolService.NODE_OVERRIDABLE_KEYS
    assert "knowledge_base_id" not in ToolService.NODE_OVERRIDABLE_KEYS
    assert "top_k" not in ToolService.NODE_OVERRIDABLE_KEYS
    assert "score_floor" not in ToolService.NODE_OVERRIDABLE_KEYS


# ---------------------------------------------------------------------------
# Hybrid fusion (2026-08-30) — pure, no DB
# ---------------------------------------------------------------------------


class _Row:
    """The shape both retrieval legs return: a row with these attributes."""

    def __init__(self, chunk_id: int, score: float, chunk_index: int = 0, content: str = "text"):
        self.id = chunk_id
        self.score = score
        self.chunk_index = chunk_index
        self.content = content
        self.document_id = uuid.uuid4()
        self.file_name = "policy.pdf"
        self.token_count = 10


def test_a_chunk_both_legs_rank_beats_one_either_leg_adores():
    """
    The property RRF exists for: agreement between two independent rankers is
    stronger evidence than a single ranker's confidence.
    """
    both = _Row(1, 0.50)
    dense_only = _Row(2, 0.90)
    lexical_only = _Row(3, 0.55)

    hits = fuse_hybrid([dense_only, both], [both, lexical_only], score_floor=0.3, top_k=3)
    assert [h.score for h in hits][0] == 0.50, "the chunk found by both legs must rank first"


def test_a_lexical_only_hit_is_admitted_below_the_score_floor():
    """
    The whole reason the lexical leg was added.

    "Can an employee approve their own expense claim?" against "Employees must
    not approve their own expenses" is a NEGATION: the answering chunk scores
    poorly on cosine however the document is chunked. Filtering lexical hits by
    the cosine floor would reintroduce exactly the miss this leg fixes.
    """
    weak_but_literal = _Row(1, 0.11)
    hits = fuse_hybrid([], [weak_but_literal], score_floor=0.3, top_k=3)
    assert len(hits) == 1
    assert hits[0].score == 0.11


def test_a_dense_hit_below_the_floor_is_still_dropped():
    """The floor keeps meaning what it meant for the leg it was measured on."""
    assert fuse_hybrid([_Row(1, 0.11)], [], score_floor=0.3, top_k=3) == []


def test_a_weak_dense_hit_is_rescued_when_the_lexical_leg_also_finds_it():
    """Appearing in the lexical leg is itself the admission, whichever leg ranked it."""
    row = _Row(1, 0.11)
    assert len(fuse_hybrid([row], [row], score_floor=0.3, top_k=3)) == 1


def test_the_returned_score_is_always_cosine_similarity():
    """
    Fusion governs ORDER only. `score` stays cosine so the retrieval playground's
    cutoff line, every stored `score_floor` and every caller keep working — an
    RRF score is ~0.016 at rank 1 and would make `score_floor: 0.3` filter
    everything.
    """
    hits = fuse_hybrid([_Row(1, 0.80)], [_Row(2, 0.42)], score_floor=0.3, top_k=5)
    assert sorted(h.score for h in hits) == [0.42, 0.80]
    assert all(h.score <= 1.0 for h in hits)


def test_a_genuine_tie_breaks_deterministically():
    """
    An unstable retrieval order makes an agent's answer irreproducible for
    reasons nobody can see.

    A real tie needs equal RRF contributions — rank 1 in one leg each, not ranks
    1 and 2 of the same leg. With cosine equal too, the chunk index decides, and
    which leg found which must not change the answer.
    """
    a = _Row(1, 0.50, chunk_index=7)
    b = _Row(2, 0.50, chunk_index=2)
    assert [h.chunk_index for h in fuse_hybrid([a], [b], score_floor=0.3, top_k=5)] == [2, 7]
    assert [h.chunk_index for h in fuse_hybrid([b], [a], score_floor=0.3, top_k=5)] == [2, 7]


def test_an_equal_rank_tie_breaks_on_cosine_before_index():
    """Both at rank 1 of a leg each, so only the cosine score separates them."""
    strong = _Row(1, 0.80, chunk_index=9)
    weak = _Row(2, 0.40, chunk_index=0)
    assert [h.score for h in fuse_hybrid([strong], [weak], score_floor=0.3, top_k=5)] == [0.80, 0.40]


def test_the_fused_list_is_trimmed_to_top_k():
    rows = [_Row(i, 0.9, chunk_index=i) for i in range(10)]
    assert len(fuse_hybrid(rows, [], score_floor=0.3, top_k=3)) == 3


def test_rank_contribution_falls_off_with_position():
    """Guards the RRF constant against being set to something that inverts it."""
    assert 1 / (RRF_K + 1) > 1 / (RRF_K + 2) > 0


def test_both_legs_empty_is_a_result_not_a_failure():
    assert fuse_hybrid([], [], score_floor=0.3, top_k=5) == []
