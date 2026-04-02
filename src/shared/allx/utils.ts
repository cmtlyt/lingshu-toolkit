import { createError } from '@/shared/throw-error';
import type { AnyFunc } from '@/shared/types/base';
import { withResolvers } from '@/shared/with-resolvers';
import type { AllxOptions } from './types';

/**
 * BFS 算法处理 waitingForGraph 的依赖关系
 */
function detectCycle(from: PropertyKey, to: PropertyKey, waitingForGraph: Map<PropertyKey, Set<PropertyKey>>): boolean {
  const visited = new Set<PropertyKey>();
  const queue = [to];
  let head = 0;
  while (head < queue.length) {
    const node = queue[head++];
    if (node === from) {
      return true;
    }
    if (visited.has(node)) {
      continue;
    }
    visited.add(node);
    const deps = waitingForGraph.get(node);
    if (deps) {
      const depsIter = deps.values();
      for (let dep = depsIter.next(); !dep.done; dep = depsIter.next()) {
        queue.push(dep.value);
      }
    }
  }
  return false;
}

function getCached(results: Record<PropertyKey, any>, depName: PropertyKey, allSettled: boolean) {
  // 已完成的依赖直接返回
  if (Reflect.getOwnPropertyDescriptor(results, depName)) {
    const cached = results[depName];
    if (allSettled) {
      return cached.status === 'rejected' ? Promise.reject(cached.reason) : Promise.resolve(cached.value);
    }
    return Promise.resolve(cached);
  }
}

function createDepResolver(
  waitingFor: Map<PropertyKey, Set<PropertyKey>>,
  resolverMap: Map<PropertyKey, PromiseWithResolvers<any>>,
  currentTask: PropertyKey,
  depName: PropertyKey,
) {
  waitingFor.set(currentTask, (waitingFor.get(currentTask) || new Set()).add(depName));

  const depResolvers = resolverMap.get(depName) || withResolvers();
  resolverMap.set(depName, depResolvers);

  return depResolvers.promise.then(
    (value) => {
      waitingFor.get(currentTask)?.delete(depName);
      return value;
    },
    (error) => {
      waitingFor.get(currentTask)?.delete(depName);
      throw error;
    },
  );
}

function cleanWaitingForGraph(waitingForGraph: Map<PropertyKey, Set<PropertyKey>>, depName: PropertyKey) {
  // 清理等待图中以 depName 为目标的所有边
  waitingForGraph.forEach((deps, task) => {
    deps.delete(depName);
    if (deps.size === 0) {
      waitingForGraph.delete(task);
    }
  });
}

export function createDepProxy(
  tasks: Record<PropertyKey, AnyFunc>,
  results: Record<PropertyKey, any>,
  options: Required<AllxOptions>,
) {
  const resolverMap = new Map<PropertyKey, PromiseWithResolvers<any>>();
  const taskNameSet = new Set(Reflect.ownKeys(tasks) as PropertyKey[]);
  const waitingForGraph = new Map<PropertyKey, Set<PropertyKey>>();

  const resolveDepFor = (depName: PropertyKey, value: any) => {
    const resolver = resolverMap.get(depName);
    if (resolver) {
      resolver.resolve(value);
      resolverMap.delete(depName);
    }
    cleanWaitingForGraph(waitingForGraph, depName);
  };

  const rejectDepFor = (depName: PropertyKey, error: any) => {
    const resolver = resolverMap.get(depName);
    if (resolver) {
      resolver.reject(error);
      resolverMap.delete(depName);
    }
    cleanWaitingForGraph(waitingForGraph, depName);
  };

  const createContextFor = (currentTask: PropertyKey) => {
    // 为每个任务单独创建一个上下文, 用于处理循环依赖
    return new Proxy(
      {},
      {
        get(_, depName: PropertyKey) {
          if (!taskNameSet.has(depName)) {
            return Promise.reject(createError('allx', `Unknown task "${String(depName)}"`));
          }

          const cached = getCached(results, depName, options.allSettled);
          if (cached) {
            return cached;
          }

          if (detectCycle(currentTask, depName, waitingForGraph)) {
            return Promise.reject(
              createError('allx', `Circular dependency detected: "${String(currentTask)}" -> "${String(depName)}"`),
            );
          }

          return createDepResolver(waitingForGraph, resolverMap, currentTask, depName);
        },
      },
    );
  };

  return { taskNameSet, createContextFor, resolveDepFor, rejectDepFor };
}

export function getValueFormatFunc(options?: AllxOptions) {
  if (!options) {
    return (value: any, _type: PromiseSettledResult<any>['status'] = 'fulfilled') => value;
  }
  if (options.allSettled) {
    return (value: any, status: PromiseSettledResult<any>['status'] = 'fulfilled') =>
      status === 'fulfilled' ? { status, value } : { status, reason: value };
  }
  return (value: any, _type: PromiseSettledResult<any>['status'] = 'fulfilled') => value;
}
