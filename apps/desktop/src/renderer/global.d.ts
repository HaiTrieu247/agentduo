// What the preload gives the page: requests to main, answered, and what main pushes. Nothing else of Electron or Node.
import type { Answer, DesktopEvent, DesktopRequest, DesktopResults } from "../shared/protocol.js";

export interface AgentduoDesktop {
  invoke<R extends DesktopRequest>(request: R): Promise<Answer<DesktopResults[R["method"]]>>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

declare global {
  interface Window {
    agentduo: AgentduoDesktop;
  }
}
