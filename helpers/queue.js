'use strict';

/**
 * Bounded-concurrency async task queue.
 *
 * At most `concurrency` tasks run simultaneously; the rest are queued and start
 * as running tasks settle. A task that rejects or throws does NOT stop or
 * reject sibling/queued tasks - each add() returns an independent promise that
 * resolves or rejects with that task's own outcome.
 *
 * Implementation uses promise chaining and a simple running counter (no
 * busy-wait, no setTimeout-as-lock).
 *
 * @example
 *   const q = new TaskQueue(3);
 *   const p = q.add(() => doWork());
 *   await q.onIdle();
 */
class TaskQueue {
    /**
     * @param {number} [concurrency=3] maximum number of tasks running at once.
     *   Values below 1 are clamped to 1.
     */
    constructor(concurrency = 3) {
        const n = Number(concurrency);
        this.concurrency = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
        /** @type {Array<() => void>} pending starters waiting for a free slot */
        this._queue = [];
        /** number of tasks currently running */
        this._running = 0;
        /** @type {Array<() => void>} resolvers waiting for the queue to drain */
        this._idleResolvers = [];
    }

    /**
     * Number of tasks currently running.
     * @returns {number}
     */
    get running() {
        return this._running;
    }

    /**
     * Number of tasks waiting for a free slot.
     * @returns {number}
     */
    get pending() {
        return this._queue.length;
    }

    /**
     * Schedule a task. `fn` is invoked when a concurrency slot is free.
     *
     * The returned promise settles with the task's own result/error and is
     * fully isolated: a rejection here never affects other tasks or the queue.
     *
     * @template T
     * @param {() => (T | Promise<T>)} fn the task to run
     * @returns {Promise<T>} resolves/rejects with the task outcome
     */
    add(fn) {
        return new Promise((resolve, reject) => {
            const start = () => {
                this._running++;
                // Isolate the task: resolve fn() through Promise.resolve so both
                // sync throws and async rejections are captured without leaking.
                Promise.resolve()
                    .then(fn)
                    .then(resolve, reject)
                    .finally(() => this._onSettled());
            };

            if (this._running < this.concurrency) {
                start();
            } else {
                this._queue.push(start);
            }
        });
    }

    /**
     * Called after each task settles: frees the slot, starts the next queued
     * task if any, and resolves idle waiters when everything has drained.
     * @private
     */
    _onSettled() {
        this._running--;
        if (this._queue.length > 0) {
            const next = this._queue.shift();
            next();
            return;
        }
        if (this._running === 0) {
            const resolvers = this._idleResolvers;
            this._idleResolvers = [];
            for (const resolve of resolvers) {
                resolve();
            }
        }
    }

    /**
     * Resolves once there are no running and no pending tasks. Resolves
     * immediately if the queue is already idle. Safe to call multiple times.
     * @returns {Promise<void>}
     */
    onIdle() {
        if (this._running === 0 && this._queue.length === 0) {
            return Promise.resolve();
        }
        return new Promise((resolve) => this._idleResolvers.push(resolve));
    }

    /**
     * Alias for {@link TaskQueue#onIdle}.
     * @returns {Promise<void>}
     */
    drain() {
        return this.onIdle();
    }
}

module.exports = { TaskQueue };
