// Prisma formats the generated schema. Ignore comments and formatting only;
// preserve token boundaries and quoted contents, including spaces inside strings.
export const schemaTokens = source => (source.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|[^\s]/g) ?? [])
  .filter(token => !token.startsWith('//'));
export const sameSchema = (left, right) => JSON.stringify(schemaTokens(left)) === JSON.stringify(schemaTokens(right));
