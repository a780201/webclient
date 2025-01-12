// chatd interface
var Chatd = function(userid, options) {
    var self = this;

    // maps the chatd shard number to its corresponding Chatd.Shard object
    self.shards = {};

    // maps a chatid to the handling Chatd.Shard object
    self.chatidshard = {};

    // maps chatids to the Message object
    self.chatidmessages = {};

    // random starting point for the new message transaction ID
    // FIXME: use cryptographically strong PRNG instead
    // CHECK: is this sufficiently collision-proof? a collision would have to occur in the same second for the same userid.
    self.msgtransactionid = '';
    self.userid = base64urldecode(userid);

    for (var i = 8; i--; ) {
        self.msgtransactionid += String.fromCharCode(Math.random()*256);
    }

    self.logger = new MegaLogger("chatd");

    self.options = $.extend({}, Chatd.DEFAULT_OPTIONS, options);

//    // debug mode
//    [
//        'onMessageUpdated',
//        'onMessageConfirm',
//        'onMessageReject',
//        'onMessageCheck',
//        'onMessageModify',
//        'onMessageStore',
//        'onMessageSeen',
//        'onMessageLastSeen',
//        'onMessageReceived',
//        'onMessageLastReceived',
//        'onRetentionChanged',
//        'onMessagesHistoryInfo',
//        'onMembersUpdated',
//        'onMessagesHistoryDone',
//        'onMessagesHistoryRequest',
//    ].forEach(function(evt) {
//            self.rebind(evt + '.chatd', function(e) {
//                console.error(evt, JSON.stringify(arguments[1]));
//            });
//    });
};

makeObservable(Chatd);

Chatd.DEFAULT_OPTIONS = {
};

// command opcodes
Chatd.Opcode = {
    'KEEPALIVE' : 0,
    'JOIN' : 1,
    'OLDMSG' : 2,
    'NEWMSG' : 3,
    'MSGUPD' : 4,
    'SEEN' : 5,
    'RECEIVED' : 6,
    'RETENTION' : 7,
    'HIST' : 8,
    'RANGE' : 9,
    'MSGID' : 10,
    'REJECT' : 11,
    'HISTDONE' : 13
};

// privilege levels
Chatd.Priv = {
    'NOCHANGE' : -2,
    'NOTPRESENT' : -1,
    'RDONLY' : 0,
    'RDWR' : 1,
    'FULL' : 2,
    'OPER' : 3
};

Chatd.MsgField = {
    'MSGID' : 0,
    'USERID' : 1,
    'TIMESTAMP' : 2,
    'MESSAGE' : 3
};

Chatd.Const = {
    'UNDEFINED' : '\0\0\0\0\0\0\0\0'
};

Chatd.MAX_KEEPALIVE_DELAY = 60000;

// add a new chatd shard
Chatd.prototype.addshard = function(chatid, shard, url) {
    // instantiate Chatd.Shard object for this shard if needed
    var newshard = !this.shards[shard];

    if (newshard) {
        this.shards[shard] = new Chatd.Shard(this, shard);
    }

    // map chatid to this shard
    this.chatidshard[chatid] = this.shards[shard];

    // add chatid to the connection's chatids
    this.shards[shard].chatids[chatid] = true;

    // always update the URL to give the API an opportunity to migrate chat shards between hosts
    this.shards[shard].url = url;

    // attempt a connection ONLY if this is a new shard.
    if (newshard) {
        this.shards[shard].reconnect();
    }

    return newshard;
};

// Chatd.Shard - everything specific to a chatd instance
Chatd.Shard = function(chatd, shard) {
    var self = this;

    // parent backlink
    self.chatd = chatd;

    // shard for this connection
    self.shard = shard;

    // active chats on this connection
    self.chatids = {};

    // queued commands
    self.cmdq = '';

    self.logger = new MegaLogger("shard-" + shard, {}, chatd.logger);

    self.keepAliveTimer = null;

    self.connectionRetryManager = new ConnectionRetryManager(
        {
            functions: {
                reconnect: function(connectionRetryManager) {
                    //console.error("reconnect was called");
                    self.reconnect();
                },
                /**
                 * A Callback that will trigger the 'forceDisconnect' procedure for this type of connection (Karere/Chatd/etc)
                 * @param connectionRetryManager {ConnectionRetryManager}
                 */
                forceDisconnect: function(connectionRetryManager) {
                    //console.error("forceDisconnect was called");
                    self.disconnect();
                },
                /**
                 * Should return true or false depending on the current state of this connection, e.g. (connected || connecting)
                 * @param connectionRetryManager {ConnectionRetryManager}
                 * @returns {bool}
                 */
                isConnectedOrConnecting: function(connectionRetryManager) {
                    return (
                        self.s && (
                            self.s.readyState == self.s.CONNECTING ||
                            self.s.readyState == self.s.OPEN
                        )
                    );
                },
                /**
                 * Should return true/false if the current state === CONNECTED
                 * @param connectionRetryManager {ConnectionRetryManager}
                 * @returns {bool}
                 */
                isConnected: function(connectionRetryManager) {
                    return (
                        self.s && (
                            self.s.readyState == self.s.OPEN
                        )
                    );
                },
                /**
                 * Should return true/false if the current state === DISCONNECTED
                 * @param connectionRetryManager {ConnectionRetryManager}
                 * @returns {bool}
                 */
                isDisconnected: function(connectionRetryManager) {
                    return (
                        !self.s || self.s.readyState == self.s.CLOSED
                    );
                },
                /**
                 * Should return true IF the user had forced the connection to go offline
                 * @param connectionRetryManager {ConnectionRetryManager}
                 * @returns {bool}
                 */
                isUserForcedDisconnect: function(connectionRetryManager) {
                    return (
                        localStorage.megaChatPresence === "unavailable"
                    );
                }
            }
        },
        self.logger
    );
};

// is this chatd connection currently active?
Chatd.Shard.prototype.isOnline = function() {
    return this.s && this.s.readyState == this.s.OPEN;
};

Chatd.Shard.prototype.reconnect = function() {
    var self = this;

    self.s = new WebSocket(this.url);
    self.s.binaryType = "arraybuffer";

    self.s.onopen = function(e) {
        self.keepAliveTimerRestart();
        self.logger.log('chatd connection established');
        self.rejoinexisting();
        self.resendpending();
    };

    self.s.onerror = function(e) {
        self.logger.error("WebSocket error:", e);
        clearTimeout(self.keepAliveTimer);
        self.connectionRetryManager.doConnectionRetry();
    };

    self.s.onmessage = function(e) {
        // verify that WebSocket frames are always delivered as a contiguous message
        self.exec(new Uint8Array(e.data));
    };

    self.s.onclose = function(e) {
        self.logger.log('chatd connection lost, reconnecting...');
        clearTimeout(self.keepAliveTimer);
        self.connectionRetryManager.gotDisconnected();
    };
};

Chatd.Shard.prototype.disconnect = function() {
    var self = this;

    if (self.s) {
        self.s.close();
    }
    self.s = null;

    clearTimeout(self.keepAliveTimer);
};

Chatd.Shard.prototype.cmd = function(opcode, cmd) {
    //console.error("CMD SENT: ", constStateToText(Chatd.Opcode, opcode), cmd);

    this.cmdq += String.fromCharCode(opcode)+cmd;

    if (this.isOnline()) {
        var a = new Uint8Array(this.cmdq.length);
        for (var i = this.cmdq.length; i--; ) {
            a[i] = this.cmdq.charCodeAt(i);
        }
        this.s.send(a);

        this.cmdq = '';
    }
};

// rejoin all open chats after reconnection (this is mandatory)
Chatd.Shard.prototype.rejoinexisting = function() {
    for (var c in this.chatids) {
        // rejoin chat and immediately set the locally buffered message range
        this.join(c);
        this.chatd.range(c);
    }
};

// resend all unconfirmed messages (this is mandatory)
Chatd.Shard.prototype.resendpending = function() {
    var self = this;
    for (var chatid in this.chatids) {
        self.chatd.chatidmessages[chatid].resend();
    }
};

// send JOIN
Chatd.Shard.prototype.join = function(chatid) {
    this.cmd(Chatd.Opcode.JOIN, chatid + this.chatd.userid + String.fromCharCode(Chatd.Priv.NOCHANGE));
};

Chatd.prototype.cmd = function(opcode, chatid, cmd) {
    this.chatidshard[chatid].cmd(opcode, chatid + cmd);
};

Chatd.prototype.hist = function(chatid, count) {
    this.chatidshard[chatid].hist(chatid, count);
};

// send RANGE
Chatd.prototype.range = function(chatid) {
    this.chatidmessages[chatid].range(chatid);
};

// send HIST
Chatd.Shard.prototype.hist = function(chatid, count) {
    this.chatd.trigger('onMessagesHistoryRequest', {
        count: count,
        chatId: base64urlencode(chatid)
    });

    this.cmd(Chatd.Opcode.HIST, chatid + this.chatd.pack32le(count));
};

/**
 * Will initialise/reset a timer that would force reconnect the shard connection IN case that the keep alive is not
 * received during a delay of max `Chatd.MAX_KEEPALIVE_DELAY` ms
 */
Chatd.Shard.prototype.keepAliveTimerRestart = function() {
    var self = this;

    if (self.keepAliveTimer) {
        clearTimeout(self.keepAliveTimer);
    }
    self.keepAliveTimer = setTimeout(function() {
        if (self.s && self.s.readyState === self.s.OPEN) {
            self.logger.error("Server heartbeat missed/delayed. Will force reconnect.");

            // current connection is active, but the keep alive detected delay of the keep alive. reconnect!
            self.disconnect();
            self.reconnect();
        }
    }, Chatd.MAX_KEEPALIVE_DELAY);
};

// inbound command processing
// multiple commands can appear as one WebSocket frame, but commands never cross frame boundaries
// CHECK: is this assumption correct on all browsers and under all circumstances?
Chatd.Shard.prototype.exec = function(a) {
    var self = this;

    var cmd = String.fromCharCode.apply(null, a);
    var len;
    var newmsg;

    while (cmd.length) {
        switch (cmd.charCodeAt(0)) {
            case Chatd.Opcode.KEEPALIVE:
                self.logger.log("Server heartbeat received");
                self.cmd(Chatd.Opcode.KEEPALIVE, "");

                self.keepAliveTimerRestart();

                len = 1;
                break;

            case Chatd.Opcode.JOIN:
                self.keepAliveTimerRestart();
                self.logger.log("Join or privilege change - user '" + base64urlencode(cmd.substr(9,8)) + "' on '" + base64urlencode(cmd.substr(1,8)) + "' with privilege level " + cmd.charCodeAt(17) );

                self.connectionRetryManager.gotConnected();

                self.chatd.trigger('onMembersUpdated', {
                    userId: base64urlencode(cmd.substr(9, 8)),
                    chatId: base64urlencode(cmd.substr(1, 8)),
                    priv: cmd.charCodeAt(17)
                });

                len = 18;
                break;

            case Chatd.Opcode.OLDMSG:
            case Chatd.Opcode.NEWMSG:
                self.keepAliveTimerRestart();
                newmsg = cmd.charCodeAt(0) == Chatd.Opcode.NEWMSG;
                len = self.chatd.unpack32le(cmd.substr(29,4));
                self.logger.log((newmsg ? 'New' : 'Old') + " message '" + base64urlencode(cmd.substr(17,8)) + "' from '" + base64urlencode(cmd.substr(9,8)) + "' on '" + base64urlencode(cmd.substr(1,8)) + "' at " + self.chatd.unpack32le(cmd.substr(25,4)) + ': ' + cmd.substr(33,len));
                len += 33;

                self.chatd.msgstore(newmsg, cmd.substr(1,8), cmd.substr(9,8), cmd.substr(17,8), self.chatd.unpack32le(cmd.substr(25,4)), cmd.substr(33,len));
                break;

            case Chatd.Opcode.MSGUPD:
                self.keepAliveTimerRestart();
                len = self.chatd.unpack32le(cmd.substr(29,4));
                self.logger.log("Message '" + base64urlencode(cmd.substr(16,8)) + "' EDIT/DELETION: " + cmd.substr(33,len));
                len += 33;

                self.chatd.msgmodify(cmd.substr(1,8), cmd.substr(9,8), cmd.substr(33,len));
                break;

            case Chatd.Opcode.SEEN:
                self.keepAliveTimerRestart();
                self.logger.log("Newest seen message on '" + base64urlencode(cmd.substr(1, 8)) + "': '" + base64urlencode(cmd.substr(9, 8)) + "'");

                self.chatd.trigger('onMessageLastSeen', {
                    chatId: base64urlencode(cmd.substr(1, 8)),
                    messageId: base64urlencode(cmd.substr(9, 8))
                });

                len = 17;
                break;

            case Chatd.Opcode.RECEIVED:
                self.keepAliveTimerRestart();
                self.logger.log("Newest delivered message on '" + base64urlencode(cmd.substr(1,8)) + "': '" + base64urlencode(cmd.substr(9,8)) + "'");

                self.chatd.trigger('onMessageLastReceived', {
                    chatId: base64urlencode(cmd.substr(1, 8)),
                    messageId: base64urlencode(cmd.substr(9, 8))
                });

                len = 17;
                break;

            case Chatd.Opcode.RETENTION:
                self.keepAliveTimerRestart();
                self.logger.log("Retention policy change on '" + base64urlencode(cmd.substr(1,8)) + "' by '" + base64urlencode(cmd.substr(9,8)) + "': " + self.chatd.unpack32le(cmd.substr(17,4)) + " second(s)");
                self.chatd.trigger('onRetentionChanged', {
                    chatId: base64urlencode(cmd.substr(1, 8)),
                    userId: base64urlencode(cmd.substr(9, 8)),
                    retention: self.chatd.unpack32le(cmd.substr(17, 4))
                });

                len = 21;
                break;

            case Chatd.Opcode.MSGID:
                self.keepAliveTimerRestart();
                self.logger.log("Sent message ID confirmed: '" + base64urlencode(cmd.substr(9,8)) + "'");

                self.chatd.msgconfirm(cmd.substr(1,8), cmd.substr(9,8));

                len = 17;
                break;
            
            case Chatd.Opcode.RANGE:
                self.keepAliveTimerRestart();
                self.logger.log("Known chat message IDs - oldest: '" + base64urlencode(cmd.substr(9,8)) + "' newest: '" + base64urlencode(cmd.substr(17,8)) + "'");

                self.chatd.trigger('onMessagesHistoryInfo', {
                    chatId: base64urlencode(cmd.substr(1,8)),
                    oldest: base64urlencode(cmd.substr(9,8)),
                    newest: base64urlencode(cmd.substr(17,8))
                });

                self.chatd.msgcheck(cmd.substr(1,8), cmd.substr(17,8));

                len = 25;
                break;

            case Chatd.Opcode.REJECT:
                self.keepAliveTimerRestart();
                self.logger.log("Command was rejected: " + self.chatd.unpack32le(cmd.substr(9,4)) + " / " + self.chatd.unpack32le(cmd.substr(13,4)));

                if (self.chatd.unpack32le(cmd.substr(9,4)) == Chatd.Opcode.NEWMSG) {
                    // the message was rejected
                    self.chatd.msgconfirm(cmd.substr(1,8), false);
                }

                len = 17;
                break;

            case Chatd.Opcode.HISTDONE:
                self.keepAliveTimerRestart();
                self.logger.log("History retrieval finished: " + base64urlencode(cmd.substr(1,8)));

                self.chatd.trigger('onMessagesHistoryDone',
                    {
                        chatId: base64urlencode(cmd.substr(1,8))
                    }
                );

                len = 9;
                break;

            default:
                self.logger.error(
                    "FATAL: Unknown opcode " + cmd.charCodeAt(0) +
                    ". To stop potential loop-forever case, the next commands in the buffer were rejected!"
                );
                // remove the command from the queue, its already processed, if this is not done, the code will loop forever
                cmd = "";
        }

        if (cmd.length < len) {
            self.logger.error(
                "FATAL: Short WebSocket frame - got " + cmd.length + ", expected " + len +
                ". To stop potential loop-forever case, the next commands in the buffer were rejected!"
            );

            // remove the command from the queue, its already processed, if this is not done, the code will loop forever
            cmd = "";
            break;
        }

        cmd = cmd.substr(len);
    }
};

// generate and return next msgtransactionid in sequence
Chatd.prototype.nexttransactionid = function() {
    for (var i = 0; i < this.msgtransactionid.length; i++) {
        //TODO: LP: @Mathias: what is `c`?
        var c = (this.msgtransactionid.charCodeAt(i)+1) & 0xff;

        this.msgtransactionid = this.msgtransactionid.substr(0,i) + String.fromCharCode(c) + this.msgtransactionid.substr(i+1);

        if (c) {
            break;
        }
    }

    return this.msgtransactionid;
};

Chatd.prototype.join = function(chatid, shard, url) {
    if (!this.chatidshard[chatid]) {
        var newshard = this.addshard(chatid, shard, url);
        this.chatidmessages[chatid] = new Chatd.Messages(this, chatid);
        if (!newshard) {
            this.shards[shard].join(chatid);
        }
    }
};

// submit a new message to the chatid
Chatd.prototype.submit = function(chatid, message) {
    if (this.chatidmessages[chatid]) {
        return this.chatidmessages[chatid].submit(message);
    }
    else {
        return false;
    }
};

// edit or delete an existing message, returns false upon failure
Chatd.prototype.modify = function(chatid, msgnum, message) {
    if (!this.chatidmessages[chatid]) {
        return false;
    }

    return this.chatidmessages[chatid].modify(msgnum, message);
};

Chatd.Shard.prototype.msg = function(chatid, msgxid, timestamp, message) {
    this.cmd(Chatd.Opcode.NEWMSG, chatid + Chatd.Const.UNDEFINED + msgxid + this.chatd.pack32le(timestamp) + this.chatd.pack32le(message.length) + message);
};

Chatd.Shard.prototype.msgupd = function(chatid, msgid, message) {
    this.cmd(Chatd.Opcode.MSGUPD, chatid + Chatd.Const.UNDEFINED + msgid + this.chatd.pack32le(0) + this.chatd.pack32le(message.length) + message);
};

// message storage subsystem
Chatd.Messages = function(chatd, chatid) {
    // parent linkage
    this.chatd = chatd;
    this.chatid = chatid;

    // the message buffer can grow in two directions and is always contiguous, i.e. there are no "holes"
    // there is no guarantee as to ordering
    this.lownum = 2 << 28; // oldest message in buf
    this.highnum = 2 << 28; // newest message in buf

    this.sentid = false;
    this.receivedid = false;
    this.seenid = false;

    // message format: [msgid/transactionid, userid, timestamp, message]
    // messages in buf are indexed by a numeric id
    this.buf = {};

    // mapping of transactionids of messages being sent to the numeric index of this.buf
    this.sending = {};

    // msgnums of modified messages
    this.modified = {};
};

Chatd.Messages.prototype.submit = function(message) {
    // allocate a transactionid for the new message
    var msgxid = this.chatd.nexttransactionid();
    var timestamp = Math.floor(new Date().getTime()/1000);

    // write the new message to the message buffer and mark as in sending state
    // FIXME: there is a tiny chance of a namespace clash between msgid and msgxid, FIX
    this.buf[++this.highnum] = [msgxid, this.chatd.userid, timestamp, message];

    this.chatd.trigger('onMessageUpdated', {
        chatId: base64urlencode(this.chatid),
        id: this.highnum,
        state: 'PENDING',
        message: message
    });


    this.sending[msgxid] = this.highnum;

    // if we believe to be online, send immediately
    if (this.chatd.chatidshard[this.chatid].isOnline()) {
        this.chatd.chatidshard[this.chatid].msg(this.chatid, msgxid, timestamp, message);
    }
    return this.highnum;
};

Chatd.Messages.prototype.modify = function(msgnum, message) {
    var self = this;

    // TODO: LP: Mathias: this variable is not used, why ?
    var mintimestamp = Math.floor(new Date().getTime()/1000)-600;

    // modify pending message so that a potential resend includes the change
    if (this.sending[this.buf[msgnum][Chatd.MsgField.MSGID]]) {
        this.buf[msgnum][Chatd.MsgField.MESSAGE] = message;
    }
    else if (self.chatd.chatidshard[this.chatid].isOnline()) {
        self.chatd.chatidshard[this.chatid].msgupd(this.chatid, this.buf[msgnum][Chatd.MsgField.MSGID], message);
    }

    this.chatd.trigger('onMessageModify', {
        chatId: base64urlencode(this.chatid),
        id: msgnum,
        message: message
    });

    this.chatd.trigger('onMessageUpdated', {
        chatId: base64urlencode(this.chatid),
        id: msgnum,
        state: 'EDITING',
        message: message
    });

    // record this modification for resending purposes
    this.modified[msgnum] = 1;

    // FIXME: client-side prefiltering for the server-side modification time barrier
    // FIXME: overwrite failed modifications with the original message
};

Chatd.Messages.prototype.resend = function() {
    var self = this;

    // resend all pending new messages and modifications
    for (var msgxid in this.sending) {
        self.chatd.chatidshard[this.chatid].msg(
            this.chatid,
            msgxid,
            this.buf[this.sending[msgxid]][Chatd.MsgField.TIMESTAMP],
            this.buf[this.sending[msgxid]][Chatd.MsgField.MESSAGE]
        );
    }

    // resend all pending modifications of completed messages
    for (var msgnum in this.modified) {
        if (!this.sending[this.buf[msgnum][Chatd.MsgField.MSGID]]) {
            self.chatd.chatidshard[this.chatid].msgupd(
                this.chatid,
                this.buf[msgnum][Chatd.MsgField.MSGID],
                this.buf[msgnum][Chatd.MsgField.MESSAGE]
            );
        }
    }
};

// after a reconnect, we tell the chatd the oldest and newest buffered message
Chatd.Messages.prototype.range = function(chatid) {
    var low, high;

    for (low = this.lownum; low <= this.highnum; low++) {
        if (this.buf[low] && !this.sending[this.buf[low][Chatd.MsgField.MSGID]]) {
            for (high = this.highnum; high > low; high--) {
                if (!this.sending[this.buf[high][Chatd.MsgField.MSGID]]) break;
            }
            this.chatd.cmd(Chatd.Opcode.RANGE, chatid, this.buf[low][Chatd.MsgField.MSGID] + this.buf[high][Chatd.MsgField.MSGID]);
            break;
        }
    }
};

Chatd.prototype.msgconfirm = function(msgxid, msgid) {
    // CHECK: is it more efficient to keep a separate mapping of msgxid to Chatd.Messages?
    for (var chatid in this.chatidmessages) {
        if (this.chatidmessages[chatid].sending[msgxid]) {
            if (this.chatidmessages[chatid]) {
                this.chatidmessages[chatid].confirm(chatid, msgxid, msgid);
            }
            break;
        }
    }
};

// msgid can be false in case of rejections
Chatd.Messages.prototype.confirm = function(chatid, msgxid, msgid) {
    var self = this;
    var num = this.sending[msgxid];

    delete this.sending[msgxid];

    this.buf[num][Chatd.MsgField.MSGID] = msgid;
    this.chatd.trigger('onMessageUpdated', {
        chatId: base64urlencode(chatid),
        id: num,
        state: "CONFIRMED",
        messageId: base64urlencode(msgid),
        message: this.buf[num][Chatd.MsgField.MESSAGE]
    });

    if (msgid === false) {
        this.chatd.trigger('onMessageReject', {
            chatId: base64urlencode(chatid),
            id: num,
            messageId: base64urlencode(msgid),
            message: this.buf[num][Chatd.MsgField.MESSAGE]
        });
    }
    else {
        this.chatd.trigger('onMessageConfirm', {
            chatId: base64urlencode(chatid),
            id: num,
            messageId: base64urlencode(msgid),
            message: this.buf[num][Chatd.MsgField.MESSAGE]
        });
    }

    // we now have a proper msgid, resend MSGUPD in case the edit crossed the execution of the command
    if (this.modified[num]) {
        self.chatd.msgupd(chatid, msgid, this.buf[num][Chatd.MsgField.MESSAGE]);
    }
};

Chatd.prototype.msgstore = function(newmsg, chatid, userid, msgid, timestamp, msg) {
    if (this.chatidmessages[chatid]) {
        this.chatidmessages[chatid].store(newmsg, userid, msgid, timestamp, msg);
    }
};

Chatd.Messages.prototype.store = function(newmsg, userid, msgid, timestamp, msg) {
    var id;

    if (newmsg) {
        id = ++this.highnum;
    }
    else {
        id = this.lownum--;
    }

    // store message
    this.buf[id] = [msgid, userid, timestamp, msg];

    this.chatd.trigger('onMessageStore', {
        chatId: base64urlencode(this.chatid),
        id: id,
        messageId: base64urlencode(msgid),
        userId: base64urlencode(userid),
        ts: timestamp,
        message: msg,
        isNew: newmsg
    });
};

Chatd.prototype.msgmodify = function(chatid, msgid, msg) {
    // an existing message has been modified
    if (this.chatidmessages[chatid]) {
        this.chatidmessages[chatid].msgmodify(msgid, msg);
    }
};

Chatd.Messages.prototype.msgmodify = function(chatid, msgid, msg) {
    // CHECK: is it more efficient to maintain a full hash msgid -> num?
    // FIXME: eliminate namespace clash collision risk
    for (var i = this.highnum; i > this.lownum; i--) {
        if (this.buf[i][Chatd.MsgField.MSGID] === msgid) {
            // if we modified the message, remove from this.modified.
            // if someone else did before us, resend the MSGUPD (might be redundant)
            if (this.modified[i]) {
                if (this.buf[i][Chatd.MsgField.MESSAGE] === msg) {
                    delete this.modified[i];
                }
                else {
                    this.chatd.chatidshard[chatid].msgupd(chatid, msgid, msg);
                }
            }
            else {
                this.buf[i][Chatd.MsgField.MESSAGE] = msg;
            }

            break;
        }
    }
};

Chatd.prototype.msgcheck = function(chatid, msgid) {
    if (this.chatidmessages[chatid]) {
        this.chatidmessages[chatid].check(chatid, msgid);
    }
};

Chatd.Messages.prototype.check = function(chatid, msgid) {
    this.chatd.trigger('onMessageCheck', {
        chatId: base64urlencode(chatid),
        messageId: base64urlencode(msgid)
    });

    if (this.buf[this.highnum]) {
        // if the newest held message is not current, initiate a fetch of newer messages just in case
        if (this.buf[this.highnum][Chatd.MsgField.MSGID] !== msgid) {
            this.chatd.cmd(Chatd.Opcode.HIST, chatid, this.chatd.pack32le(32));
        }
    }
};

// utility functions
Chatd.prototype.pack32le = function(x) {
    var r = '';

    for (var i = 4; i--; ) {
        r += String.fromCharCode(x & 255);
        x >>= 8;
    }

    return r;
};

Chatd.prototype.unpack32le = function(x) {
    var r = 0;

    for (var i = 4; i--; ) {
        r = (r << 8)+x.charCodeAt(i);
    }

    return r;
};
