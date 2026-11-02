import { expect, test } from '@rstest/core';
import protobuf from 'protobufjs';

import { parseScipIndex, scipShortName } from './index';

const schema = protobuf.parse(`syntax = "proto3";
message Index { repeated Document documents = 2; }
message Document { string relative_path = 1; repeated Occurrence occurrences = 2; int32 position_encoding = 6; }
message SingleLineRange { int32 line = 1; int32 start_character = 2; int32 end_character = 3; }
message MultiLineRange { int32 start_line = 1; int32 start_character = 2; int32 end_line = 3; int32 end_character = 4; }
message Occurrence { repeated int32 range = 1; string symbol = 2; int32 symbol_roles = 3; SingleLineRange single_line_range = 8; MultiLineRange multi_line_range = 9; }
`).root.lookupType('Index');

test('SCIP typed ranges take precedence and retain columns, encoding, roles and malformed/local counts', () => {
  const payload = schema.encode(schema.create({ documents: [{ relativePath: 'src/a.ts', positionEncoding: 2, occurrences: [
    { symbol: 'scip-typescript npm fixture 0 A#save().', symbolRoles: 1, range: [99, 1, 9], singleLineRange: { line: 2, startCharacter: 3, endCharacter: 7 } },
    { symbol: 'scip-typescript npm fixture 0 A#save().', multiLineRange: { startLine: 5, startCharacter: 4, endLine: 6, endCharacter: 10 } },
    { symbol: 'local 0', range: [7, 0, 4] },
    { symbol: 'invalid', range: [0, 1] },
    { symbol: 'reverse', range: [3, 5, 2] },
  ] }] })).finish();
  const result = parseScipIndex(payload);
  expect(result.documents[0]?.positionEncoding).toBe('utf16');
  expect(result.documents[0]?.occurrences).toEqual([
    { symbol: 'scip-typescript npm fixture 0 A#save().', isDefinition: true, startLine: 3, startColumn: 3, endLine: 3, endColumn: 7 },
    { symbol: 'scip-typescript npm fixture 0 A#save().', isDefinition: false, startLine: 6, startColumn: 4, endLine: 7, endColumn: 10 },
  ]);
  expect(result.ignoredLocalOccurrences).toBe(1);
  expect(result.malformedOccurrences).toBe(2);
  expect(scipShortName('scip-typescript npm fixture 0 A#save().')).toBe('save');
  expect(scipShortName('scip-typescript npm fixture 0 hello().')).toBe('hello');
  expect(scipShortName('scip-typescript npm fixture 0 `src/file.ts`/A#`strange.name`().')).toBe('strange.name');
});
