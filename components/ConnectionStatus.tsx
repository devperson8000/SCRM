import { css, type Component } from "dreamland/core";
import { connectionState } from "../store";

const LABELS: Record<string, string> = {
  connecting: "Connecting",
  online: "Connected",
  reconnecting: "Reconnecting",
  offline: "Offline",
};

const ConnectionStatus: Component<{}> = function () {
  return (
    <div class="connection-status" data-status={use(connectionState.status)}>
      <span class="dot"></span>
      <span class="label">
        {use(connectionState.status).map((s) => LABELS[s] ?? s)}
      </span>
    </div>
  );
};

ConnectionStatus.style = css`
  :scope {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: rgba(255, 255, 255, 0.65);
    user-select: none;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #6b7280;
    box-shadow: 0 0 0 rgba(0, 0, 0, 0);
    transition: background 0.2s ease;
  }

  :scope[data-status="online"] .dot {
    background: #00ff88;
    box-shadow: 0 0 8px rgba(0, 255, 136, 0.6);
  }

  :scope[data-status="connecting"] .dot,
  :scope[data-status="reconnecting"] .dot {
    background: #fdd76c;
    box-shadow: 0 0 8px rgba(253, 215, 108, 0.5);
    animation: connection-status-pulse 1s ease-in-out infinite;
  }

  :scope[data-status="offline"] .dot {
    background: #ff4d4d;
    box-shadow: 0 0 8px rgba(255, 77, 77, 0.5);
  }

  @keyframes connection-status-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
`;

export default ConnectionStatus;
