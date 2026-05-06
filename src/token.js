'use strict';

function estimateTokens(text, config = {}) {
  const charsPerToken = Number(config?.limits?.chars_per_token || 4);
  return Math.ceil(String(text || '').length / Math.max(1, charsPerToken));
}

function detectLevel(tokens, config = {}, model = 'default') {
  const models = config?.limits?.models || {};
  const limits = models[model] || models.default || { quality_ceiling: 160000 };
  const ceiling = Number(limits.quality_ceiling || limits.max || 160000);
  const pct = ceiling > 0 ? tokens / ceiling : 0;
  const t = config?.limits?.thresholds || {};
  const level = pct >= (t.critical || 0.9) ? 'critical'
    : pct >= (t.urgent || 0.75) ? 'urgent'
    : pct >= (t.compact || 0.55) ? 'compact'
    : pct >= (t.watch || 0.4) ? 'watch'
    : 'comfortable';
  return { model, tokens, ceiling, pct, level };
}

module.exports = {
  estimateTokens,
  detectLevel,
};
