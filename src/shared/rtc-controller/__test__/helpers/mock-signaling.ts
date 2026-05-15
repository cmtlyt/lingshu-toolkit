/**
 * 测试用内存信令适配器对
 *
 * 对应 RFC.md「Mock 信令适配器」章节
 *
 * 模拟双端通信：A 发送的消息 → B 的 handlers 接收，反之亦然
 */

import type { SignalingAdapter, SignalingMessage } from '../../types';

/**
 * 创建一对内存信令适配器，模拟双端通信
 *
 * @returns [adapterA, adapterB]：A 的 send 触发 B 的 onMessage 回调，反之亦然
 */
function createMockSignalingPair(): [SignalingAdapter, SignalingAdapter] {
  const handlersA: Array<(msg: SignalingMessage) => void> = [];
  const handlersB: Array<(msg: SignalingMessage) => void> = [];

  const adapterA: SignalingAdapter = {
    send(message) {
      for (let i = 0; i < handlersB.length; i++) {
        handlersB[i](message);
      }
    },
    onMessage(callback) {
      handlersA.push(callback);
      return () => {
        const idx = handlersA.indexOf(callback);
        if (idx >= 0) {
          handlersA.splice(idx, 1);
        }
      };
    },
    dispose() {
      handlersA.length = 0;
    },
  };

  const adapterB: SignalingAdapter = {
    send(message) {
      for (let i = 0; i < handlersA.length; i++) {
        handlersA[i](message);
      }
    },
    onMessage(callback) {
      handlersB.push(callback);
      return () => {
        const idx = handlersB.indexOf(callback);
        if (idx >= 0) {
          handlersB.splice(idx, 1);
        }
      };
    },
    dispose() {
      handlersB.length = 0;
    },
  };

  return [adapterA, adapterB];
}

export { createMockSignalingPair };
