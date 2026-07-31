// supabaseCompat.js
//
// Minimaler Ersatz für die zwei Mongoose-Modelle (GuildConfig, ButtonAction),
// die server.js und bot.js bisher genutzt haben - auf dieselbe Supabase-
// Tabellenstruktur (id, guild_id, document jsonb) wie main.py's
// supabase_compat.py gemappt, damit Bot (Python) und Dashboard (Node)
// weiterhin dieselben Zeilen lesen/schreiben.
//
// Deckt NUR ab, was server.js/bot.js tatsächlich brauchen:
//   GuildConfig.findOne({ guildId }).lean()
//   GuildConfig.findOneAndUpdate({ guildId }, { $set: { 'data.<modul>': x } }, { upsert, new })
//   ButtonAction.create({ id, guildId, action })

const { createClient } = require('@supabase/supabase-js');

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// Setzt einen Wert an einem Mongo-artigen Dot-Pfad ('data.welcome') im
// Dokument, legt fehlende Zwischen-Objekte an.
function setPath(doc, dottedKey, value) {
  const parts = dottedKey.split('.');
  let target = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof target[part] !== 'object' || target[part] === null || Array.isArray(target[part])) {
      target[part] = {};
    }
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
  return doc;
}

function makeGuildConfigModel(supabase) {
  const TABLE = 'guild_configs';
  return {
    // server.js/bot.js rufen das IMMER als `await GuildConfig.findOne({...}).lean()`
    // auf - findOne() selbst ist daher synchron und liefert nur ein Objekt mit
    // .lean(), das die eigentliche (async) Abfrage ausführt.
    findOne({ guildId }) {
      return {
        async lean() {
          const { data, error } = await supabase
            .from(TABLE)
            .select('document')
            .eq('document->>guildId', String(guildId))
            .limit(1);
          if (error) throw error;
          if (!data || data.length === 0) return null;
          return data[0].document;
        },
      };
    },

    async findOneAndUpdate({ guildId }, update, opts = {}) {
      const { data: existingRows, error: selErr } = await supabase
        .from(TABLE)
        .select('*')
        .eq('document->>guildId', String(guildId))
        .limit(1);
      if (selErr) throw selErr;

      let row = existingRows && existingRows[0];
      let document = row ? row.document : { guildId: String(guildId), data: {} };

      for (const [op, fields] of Object.entries(update || {})) {
        if (op === '$set') {
          for (const [k, v] of Object.entries(fields)) {
            setPath(document, k, v);
          }
        } else {
          throw new Error(`Update-Operator '${op}' wird von supabaseCompat nicht unterstützt`);
        }
      }

      if (row) {
        const { error: updErr } = await supabase
          .from(TABLE)
          .update({ document, guild_id: String(guildId) })
          .eq('id', row.id);
        if (updErr) throw updErr;
      } else {
        if (!opts.upsert) return null;
        const { error: insErr } = await supabase
          .from(TABLE)
          .insert({ id: String(guildId), guild_id: String(guildId), document });
        if (insErr) throw insErr;
      }
      return document;
    },
  };
}

function makeButtonActionModel(supabase) {
  const TABLE = 'button_actions';
  return {
    async create({ id, guildId, action }) {
      const document = { id, guildId, action, createdAt: new Date().toISOString() };
      const { error } = await supabase
        .from(TABLE)
        .insert({ id, guild_id: String(guildId), document });
      if (error) throw error;
      return document;
    },
  };
}

module.exports = { createSupabaseClient, makeGuildConfigModel, makeButtonActionModel };
