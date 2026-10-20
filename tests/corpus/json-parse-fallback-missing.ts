// A `JSON.parse(text) as T` whose value lacks required members keeps the
// parsed value: missing members read undefined, as in Node.
interface Address {
  city: string;
  zip: string;
}
interface User {
  id: number;
  name: string;
  admin: boolean;
  address: Address;
  tags: string[];
}

function describe(text: string): void {
  const user = JSON.parse(text) as User;
  console.log("id", user.id, typeof user.id);
  console.log("name", user.name, user.name === undefined);
  console.log("admin", user.admin ? "yes" : "no", !user.admin);
  console.log("city", user.address?.city ?? "(no city)");
  console.log("zip?", "zip" in (user.address ?? {}));
  console.log("tags", user.tags?.length ?? 0);
  if (!user.address) console.log("no address");
  else console.log("address", user.address.city, user.address.zip);
  try {
    console.log("street", user.address.city.length);
  } catch (e) {
    console.log("read threw", e instanceof TypeError, (e as Error).message);
  }
  console.log(`label: ${user.name}#${user.id}`);
}

describe('{"id":1,"name":"ada","admin":true,"address":{"city":"London","zip":"N1"},"tags":["a"]}');
describe('{"id":2}');
describe('{"name":"bob","address":{"city":"Paris"}}');
describe("{}");
