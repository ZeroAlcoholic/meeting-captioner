import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render errors so a bug cannot blank the projector.
 *
 * Without a boundary React unmounts the whole tree on any render throw, and
 * what the room sees is a white screen with no explanation and no way back
 * short of someone finding the laptop and reloading it. For a caption system
 * running in front of an audience that is the worst possible failure mode: it
 * is silent, total, and happens at exactly the moment nobody can debug it.
 *
 * Used in two layers. The inner one wraps the caption board, so a bug in
 * caption rendering leaves the controls and the export button alive. The outer
 * one wraps the app as the last line — it should never fire, and if it does the
 * meeting is over, so it says so plainly instead of pretending otherwise.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Shown as the headline. Say what stopped, in the operator's terms. */
  title: string;
  /** What the operator should do next. One sentence, no jargon. */
  advice: string;
  /** Marks the boundary in tests and screenshots. */
  testId: string;
}

interface ErrorBoundaryState {
  message: string | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the stack in the console for whoever debugs this afterwards. It must
    // not reach the screen: a component stack in front of a room tells the
    // audience nothing and tells the operator nothing they can act on.
    console.error('[caption] render error caught by boundary', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { message } = this.state;
    if (message === null) return this.props.children;

    return (
      <div className="error-boundary" role="alert" data-testid={this.props.testId}>
        <strong className="error-boundary-title">{this.props.title}</strong>
        <p className="error-boundary-advice">{this.props.advice}</p>
        <button type="button" className="error-boundary-reload" onClick={this.handleReload}>
          重新載入
        </button>
        <p className="error-boundary-detail">{message}</p>
      </div>
    );
  }
}
