[@ai16z/eliza v0.1.4-alpha.3](../index.md) / CharacterTable

# Type Alias: CharacterTable

> **CharacterTable**: `object`

Represents a character in db
Stored Character as JSONB as the characterState is more efficient for jsonb/nosql
Other approach is to store each field as a table like character_settings,
character_knowledge, character_plugins, etc.

## Type declaration

### id

> **id**: [`UUID`](UUID.md)

### name

> **name**: `string`

### characterState

> **characterState**: [`Character`](Character.md)

### secretsIV?

> `optional` **secretsIV**: [`Secrets`](Secrets.md)

## Defined in

[packages/core/src/types.ts:502](https://github.com/Ungate-Ai/chitti/blob/main/packages/core/src/types.ts#L502)
