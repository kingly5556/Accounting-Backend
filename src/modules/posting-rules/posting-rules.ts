import { z } from "zod";
import { AppError } from "../../shared/middleware/error-handler.js";
import { ACCOUNT_CODES } from "./mapping.js";

// Pure translation: event -> the lines that should be booked, by account CODE.
// No database access here, so every rule is unit-testable on its own.

const satang = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((v) => BigInt(v))
  .refine((v) => v > 0n, "amountSatang must be greater than zero");

const base = {
  version: z.literal(1),
  occurredAt: z.string().datetime({ offset: true }),
};

const goodsReceived = z.object({
  ...base,
  goodsReceiptId: z.string().min(1),
  poId: z.string().min(1),
  poNumber: z.string().optional(),
  amountSatang: satang, // sum(qtyReceived x poLine.unitCost), computed by Stock
});

const stockAdjusted = z.object({
  ...base,
  movementId: z.string().min(1),
  productId: z.string().min(1),
  sku: z.string().optional(),
  direction: z.enum(["INCREASE", "DECREASE"]),
  quantity: z.number().int().positive(),
  reason: z.string().optional(),
  amountSatang: satang, // |qty| x product.cost, computed by Stock
});

const openingBalance = z.object({
  ...base,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountSatang: satang,
});

export const postingRequestSchema = z.discriminatedUnion("topic", [
  z.object({ topic: z.literal("GOODS_RECEIVED"), payload: goodsReceived }),
  z.object({ topic: z.literal("STOCK_ADJUSTED"), payload: stockAdjusted }),
  z.object({ topic: z.literal("OPENING_BALANCE"), payload: openingBalance }),
]);

export type PostingRequest = z.infer<typeof postingRequestSchema>;

export type PlannedLine = { accountCode: string; debit: bigint; credit: bigint; memo?: string };

export type PostingPlan = {
  sourceModule: "stock";
  sourceType: string;
  sourceId: string;
  description: string;
  occurredAt: Date;
  lines: PlannedLine[];
  sourceRef?: Record<string, string>;
};

export function planPosting(req: PostingRequest): PostingPlan {
  switch (req.topic) {
    case "GOODS_RECEIVED": {
      const p = req.payload;
      return {
        sourceModule: "stock",
        sourceType: "GOODS_RECEIPT",
        sourceId: p.goodsReceiptId,
        description: `Goods received${p.poNumber ? ` against ${p.poNumber}` : ""}`,
        occurredAt: new Date(p.occurredAt),
        sourceRef: { poId: p.poId, goodsReceiptId: p.goodsReceiptId },
        lines: [
          { accountCode: ACCOUNT_CODES.inventory, debit: p.amountSatang, credit: 0n },
          { accountCode: ACCOUNT_CODES.grir, debit: 0n, credit: p.amountSatang },
        ],
      };
    }
    case "STOCK_ADJUSTED": {
      const p = req.payload;
      const increase = p.direction === "INCREASE";
      const inventory = increase
        ? { accountCode: ACCOUNT_CODES.inventory, debit: p.amountSatang, credit: 0n }
        : { accountCode: ACCOUNT_CODES.inventory, debit: 0n, credit: p.amountSatang };
      const loss = increase
        ? { accountCode: ACCOUNT_CODES.stockAdjustmentLoss, debit: 0n, credit: p.amountSatang }
        : { accountCode: ACCOUNT_CODES.stockAdjustmentLoss, debit: p.amountSatang, credit: 0n };
      return {
        sourceModule: "stock",
        sourceType: "STOCK_ADJUSTMENT",
        sourceId: p.movementId,
        description: `Stock adjustment ${increase ? "+" : "-"}${p.quantity}${p.sku ? ` ${p.sku}` : ""}${p.reason ? ` (${p.reason})` : ""}`,
        occurredAt: new Date(p.occurredAt),
        sourceRef: { productId: p.productId, movementId: p.movementId },
        // Inventory first so the ledger reads Dr/Cr in natural order for increases.
        lines: increase ? [inventory, loss] : [loss, inventory],
      };
    }
    case "OPENING_BALANCE": {
      const p = req.payload;
      return {
        sourceModule: "stock",
        sourceType: "OPENING_BALANCE",
        sourceId: p.asOf,
        description: `Opening inventory balance as of ${p.asOf}`,
        occurredAt: new Date(p.occurredAt),
        lines: [
          { accountCode: ACCOUNT_CODES.inventory, debit: p.amountSatang, credit: 0n },
          { accountCode: ACCOUNT_CODES.retainedEarnings, debit: 0n, credit: p.amountSatang },
        ],
      };
    }
    default: {
      const never: never = req;
      throw new AppError(422, `Unknown topic ${(never as { topic: string }).topic}`);
    }
  }
}
