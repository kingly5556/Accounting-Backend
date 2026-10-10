// The only place account codes for automatic postings are named. Changing where an
// event lands (e.g. GR/IR vs trade payables) is a one-line change here.
export const ACCOUNT_CODES = {
  inventory: "1300", // สินค้าคงเหลือ
  grir: "2150", // สินค้ารับแล้วยังไม่วางบิล (GR/IR)
  stockAdjustmentLoss: "5200", // ขาดทุนจากการปรับปรุงสต็อก
  retainedEarnings: "3200", // กำไรสะสม (counter-account for opening balance)
} as const;
