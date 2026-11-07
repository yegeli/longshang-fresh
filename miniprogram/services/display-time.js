// Use explicit UTC arithmetic so WeChat engines do not need Intl time-zone support.
function dateTime(value, seconds = false) {
  if (typeof value !== 'string' || !value || !Number.isFinite(Date.parse(value))) return '';
  const beijing = new Date(Date.parse(value) + 8 * 60 * 60 * 1000);
  return beijing.toISOString().replace('T', ' ').slice(0, seconds ? 19 : 16);
}
module.exports = { dateTime };
