import { Component, type PropsWithChildren } from 'react';

/**
 * 在指定毫秒后产生延迟并完成。
 *
 * @param time - 延迟时长（毫秒）
 * @returns 在指定毫秒后完成的 `void`
 */
export function sleep(time: number) {
  return new Promise((resolve) => setTimeout(resolve, time));
}

export class ErrorBoundary extends Component<PropsWithChildren<{ onError: () => void }>> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
}