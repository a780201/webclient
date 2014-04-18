(function(w) {

var _xhr_queue = [];

function newXhr() {
	var xhr = new XMLHttpRequest;
	xhr.__id = parseInt(Math.random() * 0xffffffff);
	xhr.__timeout = null;
	xhr.setup_timeout = function() {
		clearTimeout(xhr.__timeout);
		xhr.__timeout = setTimeout(function(q) {
			q.ontimeout();
		}, 2*60*1000, xhr);
	};

	xhr._abort = xhr.abort;

	xhr.abort = function() {
		DEBUG('Socket: aborting', this.__id);
		xhr._abort();
		this.listener = null; /* we're done here, release this slot */
	}

	xhr.nolistener = function() {
		DEBUG('Socket: no listener for socket', this.__id);
		this._abort();
	}

	xhr.onreadystatechange = function() {
		xhr.setup_timeout();
		if (!this.listener) return this.nolistener();
		if (this.readyState == this.DONE && this.listener.on_ready) {
			clearTimeout(xhr.__timeout);
			this.listener.on_ready(arguments, this);
			this.listener = null; /* we're done here, release this slot */
		}
	}

	xhr.upload.onprogress = function() {
		xhr.setup_timeout();
		if (!xhr.listener) return xhr.nolistener(); /* no one is listening */

		if (xhr.listener.on_upload_progress) {
			xhr.listener.on_upload_progress(arguments, xhr);
		}
	}

	xhr.onerror = function() {
		clearTimeout(xhr.__timeout);
		if (!this.listener) return this.nolistener();
		if (this.listener.on_error && !this.__errored) {
			this.listener.on_error(arguments, this, 'error');
			this.listener  = null; /* release */
			this.__errored = true
			this.abort();
			DEBUG('Socket: onerror', this.__id);
			for(var i = 0; i < _xhr_queue.length; i++) {
				if (_xhr_queue[i].__id == this.__id) {
					_xhr_queue.splice(i, 1);
					break;
				}
			}
		}
	}
	xhr.ontimeout = function() {
		clearTimeout(xhr.__timeout);
		if (!this.listener) return this.nolistener();
		if (this.listener.on_error && !this.__errored) {
			this.listener.on_error(arguments, this, 'timeout');
			this.listener  = null; /* release */
			this.__errored = true
			this.abort();
			DEBUG('Socket: ontimeout', this.__id);
			for(var i = 0; i < _xhr_queue.length; i++) {
				if (_xhr_queue[i].__id == this.__id) {
					_xhr_queue.splice(i, 1);
					break;
				}
			}
		}
	}
	xhr.onprogress = function() {
		xhr.setup_timeout();
		if (!this.listener) return this.nolistener();
		if (this.listener.on_progress) {
			this.listener.on_progress(arguments, this)
		}	
	}

	return xhr;
}

w.killallXhr = function() {
	for (var i = 0; i < _xhr_queue.length; i++) {
		_xhr_queue[i].abort();
	}
}

w.getXhr = function(object) {
	for (var i = 0; i < _xhr_queue.length; i++) {
		if (!_xhr_queue[i].listener) {
			_xhr_queue[i].listener  = object;
			_xhr_queue[i].__errored = false;
			return _xhr_queue[i];
		}
	}

	/* create a new xhr object */
	var xhr = newXhr();
	xhr.listener = object;

	/* add it to the queue so we can recicle it */
	_xhr_queue.push(xhr);

	return xhr;
}


})(this);