"""
Demo seed data for the flagship workflows (build-plan days 10-12).

Three modules, and the split matters:

  graphs.py        pure data — the three workflow graphs and their sample
                   payloads. No session, no network; importable by a test that
                   only wants to assert a graph shape.
  seed.py          the runner. Goes through the real services so a graph that
                   seeds is a graph the product would accept.
  send_invoice.py  signs and POSTs the demo invoice at the webhook trigger.

Nothing here is imported by the application. It lives under `src/` for one
concrete reason: `infra/docker-compose.yml` bind-mounts `apps/api/src` into the
`api` container and nothing else, so a corpus document or a prompt edited on the
host is live in the container immediately. A sibling `apps/api/demo/` directory
would need an image rebuild for every wording change.
"""
