// 千机（Arky Copilot）品牌字标：鲸鱼 logo + 文字词标。
// 替换原 DeepSeek Harness 的 SVG 字标（hand-drawn letterform 无法直接改字，
// 改为 FishLogo + 品牌名文本，保持视觉身份同时换上自有品牌名）。

import type { IconProps } from './icons/props.ts'
import { FishLogo } from './FishLogo.tsx'

/** Display options for the official brand wordmark. */
export interface BrandWordmarkProps extends IconProps {
  /** Whether to include the leading whale mark; defaults to true. */
  includeMark?: boolean | undefined
}

/**
 * Render the full brand wordmark.
 * @param props.size - logo height in px (default 24).
 * @param props.className - extra class for layout placement.
 * @param props.includeMark - whether to include the leading whale mark.
 * @returns the optional whale mark plus the 千机 · Arky Copilot wordmark.
 */
export function BrandWordmark({
  size = 24,
  className,
  includeMark = true,
}: BrandWordmarkProps) {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        whiteSpace: 'nowrap',
      }}
    >
      {includeMark ? <FishLogo size={size} /> : null}
      <span style={{ fontSize: Math.round(size * 0.68), fontWeight: 600, lineHeight: 1 }}>
        千机 · Arky Copilot
      </span>
    </span>
  )
}
