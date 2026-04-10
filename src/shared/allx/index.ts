import { $dt, $t, dataHandler } from '@/shared/data-handler';
import { isFunction, isPromiseLike } from '@/shared/utils/verify';
import { withResolvers } from '@/shared/with-resolvers';
import type { AllxContext, AllxOptions, AllxResult } from './types';
import { createDepProxy, getValueFormatFunc } from './utils';

const validInfo = $dt({
  allSettled: $t.boolean(false),
});

/**
 * 支持自动依赖优化和完整类型推断的 Promise.all, 执行任务时自动解决依赖关系。
 *
 * @platform web, node, webworker
 * @example
 * const { a, b, c } = await allx({
 *   a() { return 1 },
 *   async b() { return 'hello' },
 *   async c() { return (await this.$.a) + 10 }
 * })
 */
async function allx<M extends Record<PropertyKey, any>, O extends AllxOptions>(
  tasks: M & ThisType<AllxContext<M>>,
  options?: O,
): Promise<AllxResult<M, O>> {
  const validOptions = dataHandler(options || {}, validInfo, { unwrap: true });
  const { allSettled } = validOptions;
  const results: Record<PropertyKey, any> = {};
  const depCtrl = createDepProxy(tasks, results, validOptions);
  const valueFormat = getValueFormatFunc(options);

  const promises = [] as Promise<any>[];

  depCtrl.taskNameSet.forEach(async (taskName) => {
    const taskFn = tasks[taskName];
    const context = { $: depCtrl.createContextFor(taskName) };

    const taskResolvers = withResolvers();
    taskResolvers.promise.then(
      (value) => {
        results[taskName] = valueFormat(value, 'fulfilled');
        depCtrl.resolveDepFor(taskName, value);
        return value;
      },
      (error) => {
        if (allSettled) {
          results[taskName] = valueFormat(error, 'rejected');
        }
        depCtrl.rejectDepFor(taskName, error);
      },
    );

    promises.push(taskResolvers.promise);

    if (isPromiseLike(taskFn)) {
      await taskFn.then(taskResolvers.resolve, taskResolvers.reject);
      return;
    }
    if (!isFunction(taskFn)) {
      taskResolvers.resolve(taskFn);
      return;
    }

    try {
      const result = await taskFn.call(context);
      taskResolvers.resolve(result);
    } catch (error) {
      taskResolvers.reject(error);
    }
  });

  if (allSettled) {
    return Promise.allSettled(promises).then(() => results as any);
  }

  return Promise.all(promises).then(() => results as any);
}

export { allx };
