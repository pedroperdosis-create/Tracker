export function formatAmount(value: string | number, decimals = 2): string {
  const num = typeof value === "string" ? Number(value) : value;
  if (Number.isNaN(num)) {
    return "0";
  }
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  }).format(num);
}

export function formatUsd(value?: number | null): string | null {
  if (!value && value !== 0) {
    return null;
  }
  return `~$${formatAmount(value, 2)}`;
}
