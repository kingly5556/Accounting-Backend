// All money in this module is a bigint count of satang (THB x 100). Never use
// float or Number for ledger amounts — see ACCOUNTING_PLAN.md (BigInt, not Int).
export function thbToSatang(thb: number): bigint {
  return BigInt(Math.round(thb * 100));
}

export function formatSatang(satang: bigint): string {
  const negative = satang < 0n;
  const abs = negative ? -satang : satang;
  const baht = abs / 100n;
  const rest = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${baht.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${rest}`;
}
