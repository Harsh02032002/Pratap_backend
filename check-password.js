const bcrypt = require('bcryptjs');

const hash = '.7DTgK2O7CFw6Hd0LLRel1yklJbSPZ/a';
const password = '123456';

bcrypt.compare(password, hash, (err, result) => {
  if (err) {
    console.error('Error:', err);
    return;
  }
  console.log('Password match:', result);
});
