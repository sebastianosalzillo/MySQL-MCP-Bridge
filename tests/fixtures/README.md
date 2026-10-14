# Legacy Office integration-test files

The small legacy Office fixtures in this directory are included solely to verify binary document reading.

- legacy-sample.doc was sourced from morungos/node-word-extractor, path __tests__/data/test01.doc, Git blob 7a07fcbfec25f670aa5aa03c340d1627d563d3f5, MIT project: https://github.com/morungos/node-word-extractor
- legacy-numbers.xls was sourced from zanlucathiago/xls-reader, path test/fixtures/numbers.xls, Git blob 75dbb114e11db50a7f9d432258d7c93e5a654334, MIT project: https://github.com/zanlucathiago/xls-reader

Test fixtures are used in read-only tests; neither parser opens Word/Excel or runs document macros.
