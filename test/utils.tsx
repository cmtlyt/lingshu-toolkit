import { Component, type PropsWithChildren } from 'react';

export function sleep(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export class ErrorBoundary extends Component<PropsWithChildren<{ onError: () => void }>> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      this.props.onError();
      return null;
    }
    return this.props.children;
  }
}
