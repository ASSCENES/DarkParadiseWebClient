// Resource checksums and the cipher of resources the server sends (byondcore 516).
//
// A resource id is BYOND's CRC-32 of the file (102455C0): MSB first, polynomial 0xAF, starting at 0xFFFFFFFF.
// Resources requested with message 60 arrive as an .rsc fragment whose entries have type | 0x80 and are
// enciphered (10260D30): each byte is XORed with the low byte of a state that starts at the resource id, and
// the state then becomes Bob Jenkins' 32-bit integer hash of (enciphered byte + state).

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i << 24;
	for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0xAF : c << 1;
	TABLE[i] = c >>> 0;
}

function crc(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = ((c << 8) ^ TABLE[(buf[i] ^ (c >>> 24)) & 255]) >>> 0;
	return c >>> 0;
}

function jenkins(a) {
	a = (Math.imul(a, 0x1001) + 0x7ed55d16) | 0;
	a = (a ^ 0xc761c23c) ^ (a >>> 19);
	a = (a + 0x165667b1 + (a << 5)) | 0;
	a = (a + 0xd3a2646c) ^ (a << 9);
	a = (a + 0xfd7046c5 + (a << 3)) | 0;
	a = (a ^ 0xb55a4f09) ^ (a >>> 16);
	return a >>> 0;
}

// Deciphers a resource with its id as the key; the result's crc() equals the id when the key is right.
function decipher(buf, id) {
	const out = Buffer.allocUnsafe(buf.length);
	let s = id >>> 0;
	for (let i = 0; i < buf.length; i++) {
		const c = buf[i];
		out[i] = c ^ (s & 255);
		s = jenkins((c + s) >>> 0);
	}
	return out;
}

module.exports = { crc, decipher };
