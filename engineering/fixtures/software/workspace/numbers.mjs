export function average(values) {
  // Reproducible defect: reduce without an initial value throws on empty input.
  return values.reduce((sum, value) => sum + value) / values.length;
}
