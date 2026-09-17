/**
 * Domain packs: extra preservation vocabulary for `[experiments]` and
 * `[invariants]`.
 *
 * A pack never changes the six-section skeleton. `[analysis]` is a handover
 * area rather than a reasoning area (Schema §2.4), so a pack only says what to
 * preserve when the record already contains it — it never asks the compaction
 * model to diagnose or to expand every possible field (Schema §5).
 *
 * @module dsh-academic-research/domains
 */

import type { ScienceDomain } from './types.ts';

/** Preservation vocabulary contributed by one domain. */
export interface DomainPack {
  /** Extra `config` fields the experiment ledger must keep when present. */
  readonly configFields: string;
  /** Extra `[invariants]` categories to look for in the record. */
  readonly invariantFields: string;
  /** Extra `[analysis] / 已有疑点` categories to keep when already recorded. */
  readonly recordedHints: string;
}

/** The three shipped packs, selected by the `domain` config. */
export const DOMAIN_PACKS: Readonly<Record<ScienceDomain, DomainPack>> = {
  general: {
    configFields: '关键参数、样本/输入、评价方式和产物；原文没写就写 `—`。',
    invariantFields: '影响当前实验解释、复现或恢复执行的原文片段。',
    recordedHints: '原文已指出的结果差异、条件不一致或未决事项。',
  },
  ml: {
    configFields:
      '模型与权重、数据版本与划分、关键训练参数、精度、seed、评测定义。'
      + '资源或 tokenizer/processor 信息只有在影响当前工作时才保留；其余写 `—`。',
    invariantFields:
      '指标与 baseline、已记录的 Δ、不确定度、重复次数及其对应实验和条件；'
      + '模型/代码/数据版本；seed 与确定性设置；评测定义；checkpoint 与配置路径。',
    recordedHints:
      '原文已指出的：指标差异、可比性疑问、收敛或资源受限条件、消融未隔离的变量。',
  },
  optics: {
    configFields:
      '波长、偏振、几何/材料和测量或仿真条件。'
      + '涉及相机、标定、不确定度时保留其已有记录；不自行计算误差合成。',
    invariantFields:
      '测量或仿真条件原文；标定记录；不确定度与其合成方式的已有描述；重复次数；原始数据路径。',
    recordedHints:
      '原文已指出的：系统误差与随机误差的区分、标定漂移、探测器线性区、可比性疑问。',
  },
};

/**
 * Resolve the configured domain, rejecting a value outside the shipped set.
 *
 * @param value - raw `domain` config.
 * @returns the validated domain key.
 * @throws when the value is not a shipped pack name.
 */
export function resolveDomain(value: string): ScienceDomain {
  if (value === 'general' || value === 'ml' || value === 'optics') return value;
  throw new Error(
    `dsh-academic-research: unknown domain "${value}" (allowed: general, ml, optics)`,
  );
}
