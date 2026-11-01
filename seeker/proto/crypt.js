// BYOND message cipher (recovered from captures).
// Each payload byte: c = p + byte(key >>> (S % 32)) + S, where S is the running sum of plaintext bytes.
// The final payload byte carries S itself as a checksum.

function decrypt(buf, key) {
	const out = Buffer.alloc(Math.max(buf.length - 1, 0));
	let s = 0;
	for (let i = 0; i < out.length; i++) {
		const p = (buf[i] - ((key >>> (s % 32)) & 0xff) - s) & 0xff;
		out[i] = p;
		s = (s + p) & 0xff;
	}
	return { data: out, ok: buf.length > 0 && buf[buf.length - 1] === s };
}

function encrypt(data, key) {
	const out = Buffer.alloc(data.length + 1);
	let s = 0;
	for (let i = 0; i < data.length; i++) {
		out[i] = (data[i] + ((key >>> (s % 32)) & 0xff) + s) & 0xff;
		s = (s + data[i]) & 0xff;
	}
	out[data.length] = s;
	return out;
}

module.exports = { decrypt, encrypt };
