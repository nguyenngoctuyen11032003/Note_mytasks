// Smart client library — pure, offline helpers (contract §4).
export { parseTaskInput } from './quickAdd.js';
export { parseExpenseInput } from './expenseParser.js';
export { suggestCategory, normalizeVi, tokenize, keywordScores, KEYWORDS } from './categorizer.js';
export { buildInsights } from './insights.js';
export { focusScore, REASON_ORDER } from './scoring.js';
