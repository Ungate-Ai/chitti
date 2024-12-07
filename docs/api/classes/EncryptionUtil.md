[@ai16z/eliza v0.1.4-alpha.3](../index.md) / EncryptionUtil

# Class: EncryptionUtil

## Constructors

### new EncryptionUtil()

> **new EncryptionUtil**(`secretKey`): [`EncryptionUtil`](EncryptionUtil.md)

#### Parameters

• **secretKey**: `string`

#### Returns

[`EncryptionUtil`](EncryptionUtil.md)

#### Defined in

[packages/core/src/crypt.ts:12](https://github.com/Ungate-Ai/chitti/blob/main/packages/core/src/crypt.ts#L12)

## Methods

### encrypt()

> **encrypt**(`data`): [`EncryptedData`](../interfaces/EncryptedData.md)

#### Parameters

• **data**: `string`

#### Returns

[`EncryptedData`](../interfaces/EncryptedData.md)

#### Defined in

[packages/core/src/crypt.ts:24](https://github.com/Ungate-Ai/chitti/blob/main/packages/core/src/crypt.ts#L24)

***

### decrypt()

> **decrypt**(`data`): `string`

#### Parameters

• **data**: [`EncryptedData`](../interfaces/EncryptedData.md)

#### Returns

`string`

#### Defined in

[packages/core/src/crypt.ts:42](https://github.com/Ungate-Ai/chitti/blob/main/packages/core/src/crypt.ts#L42)
