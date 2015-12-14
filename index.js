var app = require('http').createServer()
var io = require('socket.io')(app);
app.listen(9090,'0.0.0.0');
