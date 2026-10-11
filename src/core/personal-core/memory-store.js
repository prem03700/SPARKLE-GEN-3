/** Ephemeral, in-process store. No disk, browser storage, network, or database access. */
const COLLECTIONS=["profile","knowledge","conversations","tasks","goals","projects","artifacts"];
export function createMemoryStore() {
  const tables=new Map(COLLECTIONS.map(name=>[name,new Map()]));
  return Object.freeze({
    collections(){return [...COLLECTIONS];},
    put(collection,id,value) {
      const table=tables.get(collection);
      if(!table) throw new TypeError(`Unknown collection: ${collection}`);
      if(typeof id!=="string"||!id.trim()) throw new TypeError("A non-empty record ID is required.");
      const record=structuredClone(value);
      table.set(id,record);
      return {id,value:structuredClone(record)};
    },
    get(collection,id) {
      const table=tables.get(collection);
      if(!table) throw new TypeError(`Unknown collection: ${collection}`);
      if(!table.has(id)) return null;
      return {id,value:structuredClone(table.get(id))};
    },
    list(collection) {
      const table=tables.get(collection);
      if(!table) throw new TypeError(`Unknown collection: ${collection}`);
      return [...table.entries()].map(([id,value])=>({id,value:structuredClone(value)}));
    },
    remove(collection,id) {
      const table=tables.get(collection);
      if(!table) throw new TypeError(`Unknown collection: ${collection}`);
      return table.delete(id);
    }
  });
}
