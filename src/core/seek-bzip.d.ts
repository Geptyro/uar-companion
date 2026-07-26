declare module 'seek-bzip' {
	const Bunzip: {
		decode(input: Buffer | Uint8Array, expectedSize?: number): Buffer;
	};
	export default Bunzip;
}
