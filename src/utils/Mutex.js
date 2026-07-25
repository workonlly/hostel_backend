export class Mutex {
    constructor() {
        this._queue = [];
        this._locked = false;
    }
    
    lock() {
        return new Promise(resolve => {
            if (!this._locked) {
                this._locked = true;
                resolve();
            } else {
                this._queue.push(resolve);
            }
        });
    }
    
    unlock() {
        if (this._queue.length > 0) {
            const nextResolve = this._queue.shift();
            nextResolve();
        } else {
            this._locked = false;
        }
    }
}
