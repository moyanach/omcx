import React from "react";

export type MascotState =
  | "idle"
  | "thinking"
  | "tool"
  | "streaming"
  | "attention"
  | "done";

export interface OmcxMascotIconProps {
  mode?: "code" | "work";
  state?: MascotState;
  width?: number;
  height?: number;
  className?: string;
}

/** OMCX 双引擎像素机器人吉祥物（供空会话欢迎页与常驻状态挂件共用） */
export const OmcxMascotIcon: React.FC<OmcxMascotIconProps> = ({
  mode = "code",
  state = "idle",
  width = 34,
  height = 26,
  className = "",
}) => {
  const isWork = mode === "work";
  const primary = isWork
    ? "var(--ui-accent-purple, #c084fc)"
    : "var(--ui-accent-blue, #60a5fa)";
  const accent = isWork
    ? "var(--ui-accent-amber, #fbbf24)"
    : "var(--ui-accent-sky, #38bdf8)";

  // 不同状态下天线的语义高亮色
  const antennaColor =
    state === "attention"
      ? "var(--ui-accent-amber, #fbbf24)"
      : state === "done"
        ? "var(--ui-accent-emerald, #34d399)"
        : accent;

  return (
    <div
      className={`relative inline-flex items-center justify-center select-none omcx-mascot-root omcx-mascot-${state} ${className}`}
    >
      <svg
        width={width}
        height={height}
        viewBox="0 0 34 26"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="overflow-visible"
      >
        {/* 顶部天线 / 状态脉冲指示点 */}
        <g className="omcx-mascot-antennas">
          <rect
            className="omcx-mascot-antenna-left"
            x="7"
            y="1"
            width="2"
            height="3"
            rx="0.8"
            fill={antennaColor}
            opacity="0.9"
          />
          <rect
            className="omcx-mascot-antenna-right"
            x="25"
            y="1"
            width="2"
            height="3"
            rx="0.8"
            fill={antennaColor}
            opacity="0.9"
          />
        </g>

        {/* 机身与内嵌屏幕组 */}
        <g className="omcx-mascot-body">
          <rect
            x="4"
            y="4"
            width="26"
            height="16"
            rx="4"
            fill={primary}
            opacity="0.94"
          />
          <rect
            x="7"
            y="7"
            width="20"
            height="10"
            rx="2.5"
            fill="rgba(15, 23, 42, 0.24)"
          />

          {/* 眼睛 / 表情区 */}
          <g className="omcx-mascot-eyes">
            {state === "done" ? (
              <>
                <path
                  d="M10 12.6C10.8 10.9 12.7 10.9 13.5 12.6"
                  stroke="#ffffff"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
                <path
                  d="M20.5 12.6C21.3 10.9 23.2 10.9 24 12.6"
                  stroke="#ffffff"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
                <rect
                  x="15.7"
                  y="13.2"
                  width="2.6"
                  height="1.6"
                  rx="0.8"
                  fill={antennaColor}
                />
              </>
            ) : state === "attention" ? (
              <>
                <circle cx="11.5" cy="11.5" r="1.5" fill="#ffffff" />
                <circle cx="22.5" cy="11.5" r="1.5" fill="#ffffff" />
                {/* 感叹提示小光条 */}
                <rect
                  x="16"
                  y="9.2"
                  width="2"
                  height="3.4"
                  rx="0.9"
                  fill={antennaColor}
                />
                <rect
                  x="16"
                  y="13.6"
                  width="2"
                  height="1.6"
                  rx="0.8"
                  fill={antennaColor}
                />
              </>
            ) : isWork ? (
              <>
                <rect
                  x="10.5"
                  y="10"
                  width="3"
                  height="4"
                  rx="1"
                  fill="#ffffff"
                />
                <rect
                  x="20.5"
                  y="10"
                  width="3"
                  height="4"
                  rx="1"
                  fill="#ffffff"
                />
                <rect
                  x="15.5"
                  y="12.5"
                  width="3"
                  height="1.5"
                  rx="0.75"
                  fill={antennaColor}
                />
              </>
            ) : (
              <>
                <path
                  d="M12 10L10 12L12 14"
                  stroke="#ffffff"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M22 10L24 12L22 14"
                  stroke="#ffffff"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <rect
                  x="16"
                  y="9.5"
                  width="2"
                  height="5"
                  rx="1"
                  fill={antennaColor}
                />
              </>
            )}
          </g>
        </g>

        {/* 底座支撑脚 */}
        <g className="omcx-mascot-feet">
          <rect
            x="8"
            y="20"
            width="4"
            height="4"
            rx="1"
            fill={primary}
            opacity="0.75"
          />
          <rect
            x="22"
            y="20"
            width="4"
            height="4"
            rx="1"
            fill={primary}
            opacity="0.75"
          />
        </g>
      </svg>
    </div>
  );
};
