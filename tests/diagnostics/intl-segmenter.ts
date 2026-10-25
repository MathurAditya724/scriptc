// The native implementation covers default Unicode grapheme segmentation.
new Intl.Segmenter("en-US");
new Intl.Segmenter(undefined, { granularity: "word" });
new Intl.Segmenter(undefined, { granularity: "sentence" });
// End of the diagnostic fixture.
