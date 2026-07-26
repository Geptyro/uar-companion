// Minimal MPQ (MoPaQ) archive reader — a Go port of the parts of mpyq
// (Aku Kotkavuo, MIT) that SC2 replays need, translated from the
// uar-website TypeScript port (src/lib/server/replay/mpq.ts): user-data
// header, encrypted hash/block tables, and file reads with zlib/bzip2
// sector decompression.
package main

import (
	"bytes"
	"compress/bzip2"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

const (
	mpqFileCompress   = 0x00000200
	mpqFileEncrypted  = 0x00010000
	mpqFileSingleUnit = 0x01000000
	mpqFileSectorCRC  = 0x04000000
	mpqFileExists     = 0x80000000
)

const (
	hashTableOffset = 0
	hashA           = 1
	hashB           = 2
	hashTableKey    = 3
)

var encryptionTable = func() [0x500]uint32 {
	var table [0x500]uint32
	seed := uint32(0x00100001)
	for i := 0; i < 256; i++ {
		index := i
		for j := 0; j < 5; j++ {
			seed = (seed*125 + 3) % 0x2aaaab
			temp1 := (seed & 0xffff) << 0x10
			seed = (seed*125 + 3) % 0x2aaaab
			temp2 := seed & 0xffff
			table[index] = temp1 | temp2
			index += 0x100
		}
	}
	return table
}()

func mpqHash(text string, hashType int) uint32 {
	seed1 := uint32(0x7fed7fed)
	seed2 := uint32(0xeeeeeeee)
	for _, ch := range strings.ToUpper(text) {
		code := uint32(ch)
		value := encryptionTable[uint32(hashType)<<8+code]
		seed1 = value ^ (seed1 + seed2)
		seed2 = code + seed1 + seed2 + (seed2 << 5) + 3
	}
	return seed1
}

func decrypt(data []byte, key uint32) []byte {
	seed1 := key
	seed2 := uint32(0xeeeeeeee)
	out := make([]byte, len(data))
	words := len(data) / 4
	for i := 0; i < words; i++ {
		seed2 += encryptionTable[0x400+(seed1&0xff)]
		value := binary.LittleEndian.Uint32(data[i*4:])
		value ^= seed1 + seed2
		seed1 = ((^seed1 << 0x15) + 0x11111111) | (seed1 >> 0x0b)
		seed2 = value + seed2 + (seed2 << 5) + 3
		binary.LittleEndian.PutUint32(out[i*4:], value)
	}
	return out
}

func decompress(data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty sector")
	}
	switch data[0] {
	case 0:
		return data, nil
	case 2:
		r, err := zlib.NewReader(bytes.NewReader(data[1:]))
		if err != nil {
			return nil, err
		}
		defer r.Close()
		return io.ReadAll(r)
	case 16:
		return io.ReadAll(bzip2.NewReader(bytes.NewReader(data[1:])))
	default:
		return nil, fmt.Errorf("unsupported MPQ compression type %d", data[0])
	}
}

type blockEntry struct {
	offset       uint32
	archivedSize uint32
	size         uint32
	flags        uint32
}

type hashEntry struct {
	hashA           uint32
	hashB           uint32
	blockTableIndex uint32
}

// MPQArchive gives read access to the named files of an SC2 replay archive.
type MPQArchive struct {
	data            []byte
	archiveOffset   uint32
	sectorSizeShift uint16
	hashTable       []hashEntry
	blockTable      []blockEntry
}

func u32(data []byte, off uint32) (uint32, error) {
	if int(off)+4 > len(data) {
		return 0, errors.New("truncated MPQ data")
	}
	return binary.LittleEndian.Uint32(data[off:]), nil
}

// NewMPQArchive parses the archive headers and tables of an SC2 replay.
func NewMPQArchive(data []byte) (*MPQArchive, error) {
	magic, err := u32(data, 0)
	if err != nil || magic != 0x1b51504d {
		// 'MPQ\x1b' — SC2 replays always carry a user-data header
		return nil, errors.New("not an SC2 replay (missing MPQ user-data header)")
	}
	headerOffset, err := u32(data, 8)
	if err != nil {
		return nil, err
	}
	archMagic, err := u32(data, headerOffset)
	if err != nil || archMagic != 0x1a51504d { // 'MPQ\x1a'
		return nil, errors.New("invalid MPQ header")
	}
	a := &MPQArchive{data: data, archiveOffset: headerOffset}
	if int(headerOffset)+32 > len(data) {
		return nil, errors.New("truncated MPQ header")
	}
	a.sectorSizeShift = binary.LittleEndian.Uint16(data[headerOffset+14:])
	hashOff, _ := u32(data, headerOffset+16)
	blockOff, _ := u32(data, headerOffset+20)
	hashEntries, _ := u32(data, headerOffset+24)
	blockEntries, _ := u32(data, headerOffset+28)

	if a.hashTable, err = readHashTable(a, hashOff, hashEntries); err != nil {
		return nil, err
	}
	if a.blockTable, err = readBlockTable(a, blockOff, blockEntries); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *MPQArchive) tableBytes(offset, entries uint32) ([]byte, error) {
	start := a.archiveOffset + offset
	end := start + entries*16
	if entries > 0x10000 || int(end) > len(a.data) || end < start {
		return nil, errors.New("truncated MPQ table")
	}
	return a.data[start:end], nil
}

func readHashTable(a *MPQArchive, offset, entries uint32) ([]hashEntry, error) {
	rawEnc, err := a.tableBytes(offset, entries)
	if err != nil {
		return nil, err
	}
	raw := decrypt(rawEnc, mpqHash("(hash table)", hashTableKey))
	out := make([]hashEntry, entries)
	for i := range out {
		out[i] = hashEntry{
			hashA:           binary.LittleEndian.Uint32(raw[i*16:]),
			hashB:           binary.LittleEndian.Uint32(raw[i*16+4:]),
			blockTableIndex: binary.LittleEndian.Uint32(raw[i*16+12:]),
		}
	}
	return out, nil
}

func readBlockTable(a *MPQArchive, offset, entries uint32) ([]blockEntry, error) {
	rawEnc, err := a.tableBytes(offset, entries)
	if err != nil {
		return nil, err
	}
	raw := decrypt(rawEnc, mpqHash("(block table)", hashTableKey))
	out := make([]blockEntry, entries)
	for i := range out {
		out[i] = blockEntry{
			offset:       binary.LittleEndian.Uint32(raw[i*16:]),
			archivedSize: binary.LittleEndian.Uint32(raw[i*16+4:]),
			size:         binary.LittleEndian.Uint32(raw[i*16+8:]),
			flags:        binary.LittleEndian.Uint32(raw[i*16+12:]),
		}
	}
	return out, nil
}

// ReadFile returns the decompressed content of a named archive file, or nil
// if the archive has no such file.
func (a *MPQArchive) ReadFile(filename string) ([]byte, error) {
	ha := mpqHash(filename, hashA)
	hb := mpqHash(filename, hashB)
	var entry *hashEntry
	for i := range a.hashTable {
		if a.hashTable[i].hashA == ha && a.hashTable[i].hashB == hb {
			entry = &a.hashTable[i]
			break
		}
	}
	if entry == nil {
		return nil, nil
	}
	if entry.blockTableIndex >= uint32(len(a.blockTable)) {
		return nil, errors.New("hash entry points past block table")
	}
	block := a.blockTable[entry.blockTableIndex]
	if block.flags&mpqFileExists == 0 || block.archivedSize == 0 {
		return nil, nil
	}
	if block.flags&mpqFileEncrypted != 0 {
		return nil, errors.New("encrypted MPQ files are not supported")
	}

	start := a.archiveOffset + block.offset
	end := start + block.archivedSize
	if int(end) > len(a.data) || end < start {
		return nil, errors.New("truncated MPQ file block")
	}
	fileData := a.data[start:end]

	if block.flags&mpqFileSingleUnit != 0 {
		if block.flags&mpqFileCompress != 0 && block.size > block.archivedSize {
			return decompress(fileData)
		}
		return fileData, nil
	}

	// multi-sector file
	sectorSize := uint32(512) << a.sectorSizeShift
	sectors := block.size/sectorSize + 1
	hasCRC := block.flags&mpqFileSectorCRC != 0
	if hasCRC {
		sectors++
	}
	if int(sectors+1)*4 > len(fileData) {
		return nil, errors.New("truncated MPQ sector table")
	}
	positions := make([]uint32, sectors+1)
	for i := range positions {
		positions[i] = binary.LittleEndian.Uint32(fileData[i*4:])
	}

	var out bytes.Buffer
	bytesLeft := block.size
	count := len(positions) - 1
	if hasCRC {
		count--
	}
	for i := 0; i < count; i++ {
		if positions[i] > positions[i+1] || int(positions[i+1]) > len(fileData) {
			return nil, errors.New("invalid MPQ sector bounds")
		}
		sector := fileData[positions[i]:positions[i+1]]
		if block.flags&mpqFileCompress != 0 && bytesLeft > uint32(len(sector)) {
			var err error
			if sector, err = decompress(sector); err != nil {
				return nil, err
			}
		}
		bytesLeft -= uint32(len(sector))
		out.Write(sector)
	}
	return out.Bytes(), nil
}
