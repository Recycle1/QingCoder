/**
 * 轻量路由：后续可替换为二次模型判定或规则引擎。
 * 用于在系统提示中附加不同深度的工具策略说明。
 */
export type RouteDecision = {
  complexity: 'low' | 'medium' | 'high';
  hint: string;
};

export function routeUserIntent(userText: string): RouteDecision {
  const t = userText.toLowerCase();
  const heavy =
    /重构|架构|迁移|全项目|所有文件|大量|性能|安全|并发|分布式/.test(userText) ||
    /\brefactor\b|\bmigrate\b|\barchitecture\b/.test(t);
  const medium =
    /多文件|模块|包|目录|接口|测试/.test(userText) || /\bmodule\b|\bpackage\b/.test(t);
  if (heavy) {
    return {
      complexity: 'high',
      hint: '判定为高复杂度：先列出受影响路径与风险，再小步工具验证，避免一次性大范围改写。',
    };
  }
  if (medium) {
    return {
      complexity: 'medium',
      hint: '判定为中等复杂度：先只读浏览相关目录与入口文件，再决定是否写入。',
    };
  }
  return {
    complexity: 'low',
    hint: '判定为低复杂度：可直接用只读工具定位，若需写入保持最小改动面。',
  };
}
