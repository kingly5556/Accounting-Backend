import type { AccountType } from "@prisma/client";

export type ChartRow = { code: string; name: string; type: AccountType; parent?: string; group?: true };

// Group headers (group: true) are not postable. Codes referenced by posting rules
// live in src/modules/posting-rules/mapping.ts: 1300, 2150, 3200, 5200.
export const CHART_OF_ACCOUNTS: ChartRow[] = [
  { code: "1000", name: "สินทรัพย์", type: "ASSET", group: true },
  { code: "1100", name: "เงินสด", type: "ASSET", parent: "1000" },
  { code: "1110", name: "เงินฝากธนาคาร", type: "ASSET", parent: "1000" },
  { code: "1200", name: "ลูกหนี้การค้า", type: "ASSET", parent: "1000" },
  { code: "1300", name: "สินค้าคงเหลือ", type: "ASSET", parent: "1000" },
  { code: "2000", name: "หนี้สิน", type: "LIABILITY", group: true },
  { code: "2100", name: "เจ้าหนี้การค้า", type: "LIABILITY", parent: "2000" },
  { code: "2150", name: "สินค้ารับแล้วยังไม่วางบิล (GR/IR)", type: "LIABILITY", parent: "2000" },
  { code: "3000", name: "ส่วนของเจ้าของ", type: "EQUITY", group: true },
  { code: "3100", name: "ทุนจดทะเบียน", type: "EQUITY", parent: "3000" },
  { code: "3200", name: "กำไรสะสม", type: "EQUITY", parent: "3000" },
  { code: "4000", name: "รายได้", type: "REVENUE", group: true },
  { code: "4100", name: "รายได้จากการขาย", type: "REVENUE", parent: "4000" },
  { code: "5000", name: "ค่าใช้จ่าย", type: "EXPENSE", group: true },
  { code: "5100", name: "ต้นทุนขาย", type: "EXPENSE", parent: "5000" },
  { code: "5200", name: "ขาดทุนจากการปรับปรุงสต็อก", type: "EXPENSE", parent: "5000" },
  { code: "5300", name: "ค่าใช้จ่ายในการดำเนินงาน", type: "EXPENSE", parent: "5000" },
];
