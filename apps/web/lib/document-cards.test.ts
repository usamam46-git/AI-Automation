import { describe, expect, it } from "vitest";

import { DOCUMENT_CARDS, cardFor } from "./document-cards";
import { SCENE_NODES } from "./scene-script";

describe("DOCUMENT_CARDS", () => {
  it("covers every node in the scene", () => {
    // A node without a card renders as a blank white slab — which is exactly
    // the abstract-shape failure this whole file replaced.
    for (const node of SCENE_NODES) {
      expect(DOCUMENT_CARDS[node.id], `missing card for ${node.id}`).toBeDefined();
    }
  });

  it("has no cards for nodes that do not exist", () => {
    const ids = new Set(SCENE_NODES.map((n) => n.id));
    for (const key of Object.keys(DOCUMENT_CARDS)) {
      expect(ids.has(key), `orphan card ${key}`).toBe(true);
    }
  });

  it("marks exactly the approval nodes as gates", () => {
    const gates = Object.entries(DOCUMENT_CARDS)
      .filter(([, card]) => card.tone === "gate")
      .map(([id]) => id)
      .sort();
    const approvals = SCENE_NODES.filter((n) => n.kind === "approval")
      .map((n) => n.id)
      .sort();
    expect(gates).toEqual(approvals);
  });

  it("fits every card in the drawn layout", () => {
    // The texture draws at most three rows and two title lines; anything more
    // silently runs off the bottom of the card.
    for (const [id, card] of Object.entries(DOCUMENT_CARDS)) {
      expect(card.rows.length, `${id} has too many rows`).toBeLessThanOrEqual(3);
      expect(card.rows.length, `${id} has no rows`).toBeGreaterThan(0);
      expect(card.kind.length, `${id} kind too long`).toBeLessThanOrEqual(20);
      expect(card.reference.length, `${id} reference too long`).toBeLessThanOrEqual(14);
    }
  });
});

describe("the finance thread stays one coherent story", () => {
  /**
   * These are not style assertions. Scene 3 follows this exact invoice through
   * extraction, the amount check, the approval hold and into the ledger, using
   * the beat data in `run-film.ts`. If a figure drifts on one card, the scene
   * quietly starts contradicting itself and nobody notices.
   */
  const AMOUNT = "4,200.00";

  it("agrees on the vendor across every document that mentions one", () => {
    for (const id of ["vendor_invoice", "purchase_order", "supplier", "finance_approval"]) {
      const card = cardFor(id);
      const text = [card.title, ...card.rows.map((r) => r.value)].join(" ");
      expect(text, `${id} lost the vendor`).toContain("Acme Vendor LLC");
    }
  });

  it("agrees on the amount across the PO, the invoice, the journal and the gate", () => {
    expect(cardFor("purchase_order").total?.value).toBe(AMOUNT);
    expect(cardFor("vendor_invoice").total?.value).toBe(AMOUNT);
    expect(cardFor("finance_approval").total?.value).toBe(AMOUNT);

    const journal = Object.fromEntries(cardFor("journal_entry").rows.map((r) => [r.label, r.value]));
    expect(journal.Debit).toBe(AMOUNT);
    expect(journal.Credit).toBe(AMOUNT);
  });

  it("keeps the PO → goods receipt → invoice chain referenced", () => {
    expect(cardFor("purchase_order").reference).toBe("PO-4471");
    expect(cardFor("goods_receipt").title).toContain("PO-4471");
    expect(cardFor("vendor_invoice").reference).toBe("INV-2291");
    expect(cardFor("finance_approval").reference).toBe("INV-2291");
  });

  it("has the approval gate waiting, and naming the agent that raised it", () => {
    // The gate must never render as already approved: the entire argument of
    // the page is that nothing reaches the ledger until a person says so.
    const gate = Object.fromEntries(cardFor("finance_approval").rows.map((r) => [r.label, r.value]));
    expect(gate.Status).toBe("Waiting");
    expect(gate["Requested by"]).toBe("extract_invoice");
  });

  it("keeps the leave thread consistent between the request and its gate", () => {
    expect(cardFor("leave_request").reference).toBe("LV-3390");
    expect(cardFor("manager_approval").reference).toBe("LV-3390");
    expect(cardFor("manager_approval").title).toContain("M. Ferreira");
  });
});

describe("cardFor", () => {
  it("throws on an unknown node rather than rendering a blank card", () => {
    expect(() => cardFor("no_such_node")).toThrow(/no_such_node/);
  });
});
