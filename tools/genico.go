//go:build ignore

// One-off generator: wraps assets/icon.png into a classic 32bpp-DIB .ico
// (PNG-in-ICO entries are only reliable at 256px, tray icons are not).
//
//	go run tools/genico.go
package main

import (
	"bytes"
	"encoding/binary"
	"image"
	_ "image/png"
	"log"
	"os"
)

func main() {
	raw, err := os.ReadFile("assets/icon.png")
	if err != nil {
		log.Fatal(err)
	}
	img, _, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		log.Fatal(err)
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()

	// pixel data: BGRA rows, bottom-up
	var xor bytes.Buffer
	for y := h - 1; y >= 0; y-- {
		for x := 0; x < w; x++ {
			r, g, bl, a := img.At(b.Min.X+x, b.Min.Y+y).RGBA()
			xor.Write([]byte{byte(bl >> 8), byte(g >> 8), byte(r >> 8), byte(a >> 8)})
		}
	}
	// 1bpp AND mask, all zero (alpha channel rules), rows padded to 32 bits
	maskRow := ((w + 31) / 32) * 4
	and := make([]byte, maskRow*h)

	var dib bytes.Buffer
	bi := func(v uint32) { binary.Write(&dib, binary.LittleEndian, v) }
	bi(40)                  // BITMAPINFOHEADER size
	bi(uint32(w))           // width
	bi(uint32(h * 2))       // height incl. AND mask
	binary.Write(&dib, binary.LittleEndian, uint16(1))  // planes
	binary.Write(&dib, binary.LittleEndian, uint16(32)) // bpp
	bi(0)                   // BI_RGB
	bi(uint32(xor.Len() + len(and)))
	bi(0)
	bi(0)
	bi(0)
	bi(0)
	dib.Write(xor.Bytes())
	dib.Write(and)

	var out bytes.Buffer
	binary.Write(&out, binary.LittleEndian, uint16(0)) // reserved
	binary.Write(&out, binary.LittleEndian, uint16(1)) // type: icon
	binary.Write(&out, binary.LittleEndian, uint16(1)) // count
	wb, hb := byte(w), byte(h)
	if w >= 256 {
		wb = 0
	}
	if h >= 256 {
		hb = 0
	}
	out.Write([]byte{wb, hb, 0, 0})
	binary.Write(&out, binary.LittleEndian, uint16(1))  // planes
	binary.Write(&out, binary.LittleEndian, uint16(32)) // bpp
	binary.Write(&out, binary.LittleEndian, uint32(dib.Len()))
	binary.Write(&out, binary.LittleEndian, uint32(22)) // offset
	out.Write(dib.Bytes())

	if err := os.WriteFile("assets/icon.ico", out.Bytes(), 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("assets/icon.ico written (%d bytes, %dx%d)", out.Len(), w, h)
}
