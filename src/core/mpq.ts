/**
 * Minimal MPQ (MoPaQ) archive reader — a TS port of the parts of mpyq
 * (Aku Kotkavuo, MIT) that SC2 replays need: user-data header, encrypted
 * hash/block tables, and file reads with zlib/bzip2 sector decompression.
 */

import { inflateSync } from 'node:zlib';
import Bunzip from 'seek-bzip';

const MPQ_FILE_COMPRESS = 0x00000200;
const MPQ_FILE_ENCRYPTED = 0x00010000;
const MPQ_FILE_SINGLE_UNIT = 0x01000000;
const MPQ_FILE_SECTOR_CRC = 0x04000000;
const MPQ_FILE_EXISTS = 0x80000000;

const HASH_TYPES = { TABLE_OFFSET: 0, HASH_A: 1, HASH_B: 2, TABLE: 3 } as const;
type HashType = keyof typeof HASH_TYPES;

const encryptionTable: Uint32Array = (() => {
	const table = new Uint32Array(0x500);
	let seed = 0x00100001;
	for (let i = 0; i < 256; i++) {
		let index = i;
		for (let j = 0; j < 5; j++) {
			seed = (seed * 125 + 3) % 0x2aaaab;
			const temp1 = (seed & 0xffff) << 0x10;
			seed = (seed * 125 + 3) % 0x2aaaab;
			const temp2 = seed & 0xffff;
			table[index] = (temp1 | temp2) >>> 0;
			index += 0x100;
		}
	}
	return table;
})();

function hash(text: string, hashType: HashType): number {
	let seed1 = 0x7fed7fed;
	let seed2 = 0xeeeeeeee;
	for (const ch of text.toUpperCase()) {
		const code = ch.charCodeAt(0);
		const value = encryptionTable[(HASH_TYPES[hashType] << 8) + code];
		seed1 = (value ^ ((seed1 + seed2) >>> 0)) >>> 0;
		seed2 = (code + seed1 + seed2 + (seed2 << 5) + 3) >>> 0;
	}
	return seed1;
}

function decrypt(data: Uint8Array, key: number): Uint8Array {
	let seed1 = key;
	let seed2 = 0xeeeeeeee;
	const out = new Uint8Array(data.length);
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const outView = new DataView(out.buffer);
	const words = Math.floor(data.length / 4);
	for (let i = 0; i < words; i++) {
		seed2 = (seed2 + encryptionTable[0x400 + (seed1 & 0xff)]) >>> 0;
		let value = view.getUint32(i * 4, true);
		value = (value ^ ((seed1 + seed2) >>> 0)) >>> 0;
		seed1 = ((((~seed1 << 0x15) >>> 0) + 0x11111111) | (seed1 >>> 0x0b)) >>> 0;
		seed2 = (value + seed2 + (seed2 << 5) + 3) >>> 0;
		outView.setUint32(i * 4, value, true);
	}
	return out;
}

function decompress(data: Uint8Array): Uint8Array {
	const compressionType = data[0];
	if (compressionType === 0) return data;
	if (compressionType === 2) return inflateSync(data.subarray(1));
	if (compressionType === 16) return Bunzip.decode(Buffer.from(data.subarray(1)));
	throw new Error(`unsupported MPQ compression type ${compressionType}`);
}

interface BlockEntry {
	offset: number;
	archivedSize: number;
	size: number;
	flags: number;
}

interface HashEntry {
	hashA: number;
	hashB: number;
	blockTableIndex: number;
}

export class MPQArchive {
	private data: Uint8Array;
	private view: DataView;
	private archiveOffset: number;
	private sectorSizeShift: number;
	private hashTable: HashEntry[];
	private blockTable: BlockEntry[];
	/** MPQ user-data content — for SC2 replays, the replay header blob. */
	userDataContent: Uint8Array;

	constructor(data: Uint8Array) {
		this.data = data;
		this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);

		if (this.view.getUint32(0, true) !== 0x1b51504d) {
			// 'MPQ\x1b' — SC2 replays always carry a user-data header
			throw new Error('not an SC2 replay (missing MPQ user-data header)');
		}
		const headerOffset = this.view.getUint32(8, true);
		const userDataSize = this.view.getUint32(12, true);
		this.userDataContent = data.subarray(16, 16 + userDataSize);

		if (this.view.getUint32(headerOffset, true) !== 0x1a51504d) {
			// 'MPQ\x1a'
			throw new Error('invalid MPQ header');
		}
		this.archiveOffset = headerOffset;
		this.sectorSizeShift = this.view.getUint16(headerOffset + 14, true);
		const hashTableOffset = this.view.getUint32(headerOffset + 16, true);
		const blockTableOffset = this.view.getUint32(headerOffset + 20, true);
		const hashTableEntries = this.view.getUint32(headerOffset + 24, true);
		const blockTableEntries = this.view.getUint32(headerOffset + 28, true);

		this.hashTable = this.readHashTable(hashTableOffset, hashTableEntries);
		this.blockTable = this.readBlockTable(blockTableOffset, blockTableEntries);
	}

	private readHashTable(offset: number, entries: number): HashEntry[] {
		const raw = decrypt(
			this.data.subarray(this.archiveOffset + offset, this.archiveOffset + offset + entries * 16),
			hash('(hash table)', 'TABLE')
		);
		const view = new DataView(raw.buffer);
		const out: HashEntry[] = [];
		for (let i = 0; i < entries; i++) {
			out.push({
				hashA: view.getUint32(i * 16, true),
				hashB: view.getUint32(i * 16 + 4, true),
				blockTableIndex: view.getUint32(i * 16 + 12, true)
			});
		}
		return out;
	}

	private readBlockTable(offset: number, entries: number): BlockEntry[] {
		const raw = decrypt(
			this.data.subarray(this.archiveOffset + offset, this.archiveOffset + offset + entries * 16),
			hash('(block table)', 'TABLE')
		);
		const view = new DataView(raw.buffer);
		const out: BlockEntry[] = [];
		for (let i = 0; i < entries; i++) {
			out.push({
				offset: view.getUint32(i * 16, true),
				archivedSize: view.getUint32(i * 16 + 4, true),
				size: view.getUint32(i * 16 + 8, true),
				flags: view.getUint32(i * 16 + 12, true)
			});
		}
		return out;
	}

	readFile(filename: string): Uint8Array | null {
		const hashA = hash(filename, 'HASH_A');
		const hashB = hash(filename, 'HASH_B');
		const hashEntry = this.hashTable.find((e) => e.hashA === hashA && e.hashB === hashB);
		if (!hashEntry) return null;
		const block = this.blockTable[hashEntry.blockTableIndex];
		if (!(block.flags & MPQ_FILE_EXISTS) || block.archivedSize === 0) return null;
		if (block.flags & MPQ_FILE_ENCRYPTED) {
			throw new Error('encrypted MPQ files are not supported');
		}

		const start = this.archiveOffset + block.offset;
		const fileData = this.data.subarray(start, start + block.archivedSize);

		if (block.flags & MPQ_FILE_SINGLE_UNIT) {
			if (block.flags & MPQ_FILE_COMPRESS && block.size > block.archivedSize) {
				return decompress(fileData);
			}
			return fileData;
		}

		// multi-sector file
		const sectorSize = 512 << this.sectorSizeShift;
		let sectors = Math.floor(block.size / sectorSize) + 1;
		const hasCrc = (block.flags & MPQ_FILE_SECTOR_CRC) !== 0;
		if (hasCrc) sectors += 1;
		const view = new DataView(fileData.buffer, fileData.byteOffset, fileData.byteLength);
		const positions: number[] = [];
		for (let i = 0; i < sectors + 1; i++) positions.push(view.getUint32(i * 4, true));

		const parts: Uint8Array[] = [];
		let bytesLeft = block.size;
		const count = positions.length - (hasCrc ? 2 : 1);
		for (let i = 0; i < count; i++) {
			let sector = fileData.subarray(positions[i], positions[i + 1]);
			if (block.flags & MPQ_FILE_COMPRESS && bytesLeft > sector.length) {
				sector = decompress(sector);
			}
			bytesLeft -= sector.length;
			parts.push(sector);
		}
		const total = parts.reduce((n, p) => n + p.length, 0);
		const out = new Uint8Array(total);
		let pos = 0;
		for (const p of parts) {
			out.set(p, pos);
			pos += p.length;
		}
		return out;
	}
}
