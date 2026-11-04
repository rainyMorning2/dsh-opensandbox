import { hashPassword } from '../../src/users/accounts.mjs'
let input = ''
for await (const chunk of process.stdin) {
  input += chunk
  if (input.length > 2048) throw Error('Password input too long')
}
console.log(await hashPassword(input.replace(/\r?\n$/, '')))
