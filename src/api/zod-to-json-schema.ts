/**
 * Minimal Zod-to-JSON-Schema converter.
 *
 * Handles the Zod types used in skill parameter schemas:
 *  ZodObject, ZodString, ZodNumber, ZodBoolean, ZodEnum,
 *  ZodLiteral, ZodOptional, ZodDefault, ZodNullable, ZodArray
 *
 * Not a general-purpose converter — covers only what this project needs.
 */

import type { ZodTypeAny, ZodType } from "zod";

// ─── Zod internal type name constants ────────────────────────────────────────

const ZOD_TYPES = {
  ZodString: "ZodString",
  ZodNumber: "ZodNumber",
  ZodBoolean: "ZodBoolean",
  ZodObject: "ZodObject",
  ZodArray: "ZodArray",
  ZodOptional: "ZodOptional",
  ZodNullable: "ZodNullable",
  ZodDefault: "ZodDefault",
  ZodEnum: "ZodEnum",
  ZodLiteral: "ZodLiteral",
  ZodUnion: "ZodUnion",
  ZodDiscriminatedUnion: "ZodDiscriminatedUnion",
  ZodNativeEnum: "ZodNativeEnum",
  ZodEffects: "ZodEffects",
} as const;

// ─── Get Zod type name from schema ──────────────────────────────────────────

function getZodTypeName(schema: ZodTypeAny): string {
  // Zod 3.x stores the type name in _def.typeName or _def.type
  const def = schema._def as Record<string, unknown>;
  const typeName = def["typeName"] ?? def["type"];
  return typeof typeName === "string" ? typeName : "";
}

// ─── Extract check value ────────────────────────────────────────────────────

function getCheckValue(schema: ZodTypeAny, checkType: string): number | undefined {
  const def = schema._def as Record<string, unknown>;
  const checks = def["checks"];
  if (!Array.isArray(checks)) return undefined;

  for (const check of checks) {
    if (check && typeof check === "object" && (check as Record<string, unknown>)["kind"] === checkType) {
      const value = (check as Record<string, unknown>)["value"];
      if (typeof value === "number") return value;
    }
  }
  return undefined;
}

// ─── Main converter ──────────────────────────────────────────────────────────

/**
 * Convert a Zod schema to a JSON Schema object.
 * Returns a plain JSON-serializable object.
 */
export function zodSchemaToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const typeName = getZodTypeName(schema);

  switch (typeName) {
    case ZOD_TYPES.ZodString: {
      const jsonSchema: Record<string, unknown> = { type: "string" };
      const min = getCheckValue(schema, "min");
      const max = getCheckValue(schema, "max");
      if (min !== undefined) jsonSchema["minLength"] = min;
      if (max !== undefined) jsonSchema["maxLength"] = max;
      return jsonSchema;
    }

    case ZOD_TYPES.ZodNumber: {
      const jsonSchema: Record<string, unknown> = { type: "number" };
      const min = getCheckValue(schema, "min");
      const max = getCheckValue(schema, "max");
      if (min !== undefined) jsonSchema["minimum"] = min;
      if (max !== undefined) jsonSchema["maximum"] = max;
      // Check for int check
      const def = schema._def as Record<string, unknown>;
      const checks = def["checks"];
      if (Array.isArray(checks)) {
        for (const check of checks) {
          if (check && typeof check === "object" && (check as Record<string, unknown>)["kind"] === "int") {
            jsonSchema["type"] = "integer";
          }
        }
      }
      return jsonSchema;
    }

    case ZOD_TYPES.ZodBoolean:
      return { type: "boolean" };

    case ZOD_TYPES.ZodLiteral: {
      const def = schema._def as Record<string, unknown>;
      const value = def["value"];
      if (typeof value === "string") return { type: "string", const: value };
      if (typeof value === "number") return { type: "number", const: value };
      if (typeof value === "boolean") return { type: "boolean", const: value };
      return { const: value };
    }

    case ZOD_TYPES.ZodEnum: {
      const def = schema._def as Record<string, unknown>;
      const values = def["values"];
      return { type: "string", enum: Array.isArray(values) ? values : [] };
    }

    case ZOD_TYPES.ZodNativeEnum: {
      const def = schema._def as Record<string, unknown>;
      const enumObj = def["values"] as Record<string, unknown> | undefined;
      if (enumObj) {
        const values = Object.values(enumObj).filter((v) => typeof v === "string" || typeof v === "number");
        return { type: typeof values[0] === "string" ? "string" : "number", enum: values };
      }
      return {};
    }

    case ZOD_TYPES.ZodOptional: {
      const def = schema._def as Record<string, unknown>;
      const innerType = def["innerType"] as ZodTypeAny | undefined;
      if (innerType) {
        return zodSchemaToJsonSchema(innerType);
      }
      return {};
    }

    case ZOD_TYPES.ZodNullable: {
      const def = schema._def as Record<string, unknown>;
      const innerType = def["innerType"] as ZodTypeAny | undefined;
      if (innerType) {
        const inner = zodSchemaToJsonSchema(innerType);
        // Add null to the type
        const innerTypeStr = inner["type"];
        if (innerTypeStr) {
          inner["type"] = [innerTypeStr, "null"];
        }
        return inner;
      }
      return {};
    }

    case ZOD_TYPES.ZodDefault: {
      const def = schema._def as Record<string, unknown>;
      const innerType = def["innerType"] as ZodTypeAny | undefined;
      if (innerType) {
        const inner = zodSchemaToJsonSchema(innerType);
        // Extract default value
        const defaultValue = def["defaultValue"];
        if (typeof defaultValue === "function") {
          try {
            inner["default"] = defaultValue();
          } catch {
            // ignore
          }
        } else if (defaultValue !== undefined) {
          inner["default"] = defaultValue;
        }
        return inner;
      }
      return {};
    }

    case ZOD_TYPES.ZodArray: {
      const def = schema._def as Record<string, unknown>;
      const elementType = def["type"] as ZodTypeAny | undefined;
      const jsonSchema: Record<string, unknown> = {
        type: "array",
        items: elementType ? zodSchemaToJsonSchema(elementType) : {},
      };
      const min = getCheckValue(schema, "min");
      const max = getCheckValue(schema, "max");
      if (min !== undefined) jsonSchema["minItems"] = min;
      if (max !== undefined) jsonSchema["maxItems"] = max;
      return jsonSchema;
    }

    case ZOD_TYPES.ZodObject: {
      const def = schema._def as Record<string, unknown>;
      const shapeGetter = def["shape"];
      const shape = typeof shapeGetter === "function" ? shapeGetter() : shapeGetter;

      if (!shape || typeof shape !== "object") return { type: "object" };

      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(shape as Record<string, ZodTypeAny>)) {
        properties[key] = zodSchemaToJsonSchema(fieldSchema);

        // A field is required if it's not optional or default
        const fieldTypeName = getZodTypeName(fieldSchema);
        if (fieldTypeName !== ZOD_TYPES.ZodOptional && fieldTypeName !== ZOD_TYPES.ZodDefault) {
          required.push(key);
        }
      }

      const result: Record<string, unknown> = {
        type: "object",
        properties,
      };
      if (required.length > 0) {
        result["required"] = required;
      }

      // .strict() → additionalProperties: false
      const unknownKeys = def["unknownKeys"];
      if (unknownKeys === "strict") {
        result["additionalProperties"] = false;
      }

      return result;
    }

    case ZOD_TYPES.ZodEffects: {
      // .refine(), .transform(), etc. — extract the inner schema
      const def = schema._def as Record<string, unknown>;
      const innerType = def["schema"] as ZodTypeAny | undefined;
      if (innerType) {
        const result = zodSchemaToJsonSchema(innerType);
        // Extract refinement description if present
        const effect = def["effect"] as Record<string, unknown> | undefined;
        if (effect && effect["type"] === "refinement" && typeof effect["message"] === "string") {
          const existing = result["description"];
          result["description"] = existing
            ? `${existing} (${effect["message"]})`
            : effect["message"];
        }
        return result;
      }
      return {};
    }

    case ZOD_TYPES.ZodUnion: {
      const def = schema._def as Record<string, unknown>;
      const options = def["options"] as ZodTypeAny[] | undefined;
      if (Array.isArray(options)) {
        return {
          oneOf: options.map((opt) => zodSchemaToJsonSchema(opt)),
        };
      }
      return {};
    }

    case ZOD_TYPES.ZodDiscriminatedUnion: {
      const def = schema._def as Record<string, unknown>;
      const options = def["options"] as ZodTypeAny[] | undefined;
      if (Array.isArray(options)) {
        return {
          oneOf: options.map((opt) => zodSchemaToJsonSchema(opt)),
        };
      }
      return {};
    }

    default:
      // Unknown type — return empty schema (accepts anything)
      return {};
  }
}
