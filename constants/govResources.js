const DAY_MS = 24 * 60 * 60_000;

function defineResource(id, keyFields, numericFields, options = {}) {
  return {
    id, keyFields, numericFields,
    encoding: 'utf-8', delimiter: '|', shardCount: 64, layoutVersion: 1,
    refresh: 'daily', maxAgeMs: 3 * DAY_MS,
    minRows: 1, minSourceBytes: 100,
    ...options,
  };
}

const PRIVATE_NUMBERS = [
  'mispar_rechev', 'tozeret_cd', 'degem_cd', 'ramat_eivzur_betihuty',
  'kvutzat_zihum', 'shnat_yitzur', 'tzeva_cd', 'horaat_rishum',
];
const HEAVY_NUMBERS = [
  'mispar_rechev', 'shnat_yitzur', 'tozeret_cd', 'sug_delek_cd',
  'mishkal_kolel', 'mishkal_azmi', 'nefach_manoa', 'mishkal_mitan_harama',
  'horaat_rishum', 'mispar_mekomot_leyd_nahag', 'mispar_mekomot',
];
const WEEKLY = {refresh: 'weekly', maxAgeMs: 14 * DAY_MS};

// Numeric fields follow CKAN's schema, not guesses based on column names.
// Some plate/code fields have spaces or uppercase names. Keep those names.
const RESOURCES = {
  PRIVATE: defineResource('053cea08-09bc-40ec-8f7a-156f0677aff3',
    ['mispar_rechev'], PRIVATE_NUMBERS, {
      legacyPrivate: true, encoding: 'windows-1255', shardCount: 128,
      minRows: 3_000_000, minSourceBytes: 100_000_000,
    }),
  INACTIVE_PRIVATE: defineResource('f6efe89a-fb3d-43a4-bb61-9bf12a9b9099',
    ['mispar_rechev'], PRIVATE_NUMBERS, {
      minRows: 500_000, minSourceBytes: 100_000_000,
    }),
  MODEL_INFO: defineResource('142afde2-6228-49f9-8a29-9b6c3a0cbe40',
    ['degem_nm', 'degem_cd', 'shnat_yitzur', 'sug_degem'], [
      'tozeret_cd', 'degem_cd', 'shnat_yitzur', 'kvuzat_agra_cd', 'nefah_manoa',
      'mishkal_kolel', 'gova', 'hanaa_cd', 'mazgan_ind', 'abs_ind',
      'mispar_kariot_avir', 'hege_koah_ind', 'automatic_ind',
      'mispar_halonot_hashmal', 'halon_bagg_ind', 'galgaley_sagsoget_kala_ind',
      'argaz_ind', 'delek_cd', 'mispar_dlatot', 'koah_sus', 'mispar_moshavim',
      'bakarat_yatzivut_ind', 'kosher_grira_im_blamim', 'kosher_grira_bli_blamim',
      'sug_tkina_cd', 'sug_mamir_cd', 'technologiat_hanaa_cd',
      'kamut_CO2', 'kamut_NOX', 'kamut_PM10', 'kamut_HC', 'kamut_HC_NOX',
      'kamut_CO', 'kamut_CO2_city', 'kamut_NOX_city', 'kamut_PM10_city',
      'kamut_HC_city', 'kamut_CO_city', 'kamut_CO2_hway', 'kamut_NOX_hway',
      'kamut_PM10_hway', 'kamut_HC_hway', 'kamut_CO_hway', 'madad_yarok',
      'kvutzat_zihum', 'bakarat_stiya_menativ_ind', 'nitur_merhak_milfanim_ind',
      'zihuy_beshetah_nistar_ind', 'bakarat_shyut_adaptivit_ind',
      'zihuy_holchey_regel_ind', 'maarechet_ezer_labalam_ind',
      'matzlemat_reverse_ind', 'hayshaney_lahatz_avir_batzmigim_ind',
      'hayshaney_hagorot_ind', 'nikud_betihut', 'ramat_eivzur_betihuty',
      'teura_automatit_benesiya_kadima_ind', 'shlita_automatit_beorot_gvohim_ind',
      'zihuy_matzav_hitkarvut_mesukenet_ind', 'zihuy_tamrurey_tnua_ind',
      'zihuy_rechev_do_galgali', 'CO2_WLTP', 'HC_WLTP', 'PM_WLTP',
      'NOX_WLTP', 'CO_WLTP', 'CO2_WLTP_NEDC', 'bakarat_stiya_activ_s',
      'blima_otomatit_nesia_leahor', 'bakarat_mehirut_isa',
      'blimat_hirum_lifnei_holhei_regel_ofanaim', 'hitnagshut_cad_shetah_met',
      'alco_lock', 'dg_metach_solela',
    ], {...WEEKLY, minRows: 80_000, minSourceBytes: 40_000_000}),
  HISTORY_1: defineResource('56063a99-8a3e-4ff4-912e-5966c0279bad',
    ['mispar_rechev'], [
      'mispar_rechev', 'kilometer_test_aharon', 'shinui_mivne_ind', 'gapam_ind',
      'shnui_zeva_ind', 'shinui_zmig_ind',
    ], {...WEEKLY, shardCount: 256, minRows: 2_000_000, minSourceBytes: 100_000_000}),
  HISTORY_2: defineResource('bb2355dc-9ec7-4f06-9c3f-3344672171da',
    ['mispar_rechev'], ['mispar_rechev', 'baalut_dt'], {
      ...WEEKLY, shardCount: 256, minRows: 4_000_000, minSourceBytes: 100_000_000,
    }),
  HEAVY: defineResource('cd3acc5c-03c3-4c89-9c54-d40f93c0d790',
    ['mispar_rechev'], HEAVY_NUMBERS, {
      encoding: 'windows-1255', repairQuotes: true, minRows: 300_000, minSourceBytes: 60_000_000,
    }),
  BUS: defineResource('91d298ed-a260-4f93-9d50-d5e3c5b82ce1',
    ['bus_license_id'], ['bus_license_id', 'SeatsNum', 'production_year', 'total_kilometer'], {
      delimiter: ',', minRows: 10_000, minSourceBytes: 1_000_000,
    }),
  EQUIPMENT: defineResource('58dc4654-16b1-42ed-8170-98fadec153ea',
    ['mispar_tzama'], [
      'mispar_tzama', 'shilda_totzar_cd', 'shnat_yitzur', 'sug_tzama_cd',
      'hanaa_cd', 'koah_sus', 'mishkal_ton', 'mishkal_kolel_ton', 'kosher_harama_ton',
    ], {...WEEKLY, encoding: 'windows-1255', minRows: 150_000, minSourceBytes: 20_000_000}),
  MOTORCYCLE: defineResource('bf9df4e2-d90d-4c0a-a400-19e15af8e95f',
    ['mispar_rechev'], [
      'mispar_rechev', 'tozeret_cd', 'shnat_yitzur', 'sug_delek_cd',
      'mishkal_kolel', 'kod_omes_zmig_kidmi', 'kod_omes_zmig_ahori',
      'nefach_manoa', 'hespek', 'sug_rechev_cd', 'horaat_rishum',
      'mispar_mekomot_leyd_nahag', 'mispar_mekomot',
    ], {encoding: 'windows-1255', minRows: 150_000, minSourceBytes: 30_000_000}),
  PRICE_LIST: defineResource('39f455bf-6db0-4926-859d-017f34eacbcb',
    ['tozeret_cd', 'degem_nm', 'degem_cd', 'shnat_yitzur', 'sug_degem'],
    ['semel_yevuan', 'tozeret_cd', 'degem_cd', 'shnat_yitzur', 'mehir'], {
      ...WEEKLY, layoutVersion: 2, requiredFields: ['mehir'], minRows: 80_000, minSourceBytes: 10_000_000,
    }),
  DISABLED_CARD: defineResource('c8b9f9c8-4612-4068-934f-d4acd2e3c06e',
    ['MISPAR RECHEV'], ['MISPAR RECHEV', 'TAARICH HAFAKAT TAG', 'SUG TAV'], {
      minRows: 500_000, minSourceBytes: 10_000_000,
    }),
  INACTIVE_CARS: defineResource('6f6acd03-f351-4a8f-8ecf-df792f4f573a',
    ['mispar_rechev'], HEAVY_NUMBERS, {
      repairQuotes: true, shardCount: 256, minRows: 1_000_000, minSourceBytes: 150_000_000,
    }),
  CANCELED: defineResource('851ecab1-0622-4dbe-a6c7-f950cf82abf9',
    ['mispar_rechev'], [
      ...PRIVATE_NUMBERS, 'sug_rechev_cd', 'moed_aliya_lakvish', 'mishkal_kolel',
    ], {repairQuotes: true, shardCount: 256, minRows: 1_000_000, minSourceBytes: 250_000_000}),
  IMPORTED: defineResource('03adc637-b6fe-402b-9937-7c3d3afc9140',
    ['mispar_rechev'], [
      'mispar_rechev', 'tozeret_cd', 'sug_rechev_cd', 'mishkal_kolel',
      'shnat_yitzur', 'nefach_manoa',
    ], {encoding: 'windows-1255', minRows: 20_000, minSourceBytes: 3_000_000}),
  STATISTIC: defineResource('5e87a7a1-2f6f-41c1-8aec-7216d52a6cf6',
    ['degem_nm'], [
      'tozeret_cd', 'degem_cd', 'shnat_yitzur',
      'mispar_rechavim_pailim', 'mispar_rechavim_le_pailim',
    ], {...WEEKLY, bulk: true, encoding: 'windows-1255', minRows: 80_000, minSourceBytes: 5_000_000}),
  MISSING_RECALL: defineResource('36bf1404-0be4-49d2-82dc-2f1ead4a8b93',
    ['MISPAR_RECHEV'], ['MISPAR_RECHEV', 'RECALL_ID'], {
      minRows: 80_000, minSourceBytes: 15_000_000,
    }),
  RECALL_HISTORY: defineResource('2c33523f-87aa-44ec-a736-edbb0a82975e',
    ['RECALL_ID'], ['RECALL_ID', 'TOZAR_CD', 'SHNAT_RECALL'], {
      bulk: true, shardCount: 1, minRows: 2_000, minSourceBytes: 500_000,
    }),
};

const PLATE_FIELDS = new Set(['mispar_rechev', 'MISPAR_RECHEV', 'MISPAR RECHEV', 'bus_license_id']);

function keyPart(resource, field, value) {
  if (value === null || value === undefined || value === '') return null;
  if (PLATE_FIELDS.has(field)) {
    if (!/^\d{1,8}$/.test(String(value))) return null;
    return String(Number(value)).padStart(8, '0');
  }
  if (resource.numericFields.includes(field) && !Number.isFinite(Number(value))) return null;
  return resource.numericFields.includes(field) ? String(Number(value)) : String(value).trim();
}

function lookupKey(resource, values) {
  const parts = resource.keyFields.map((field) => keyPart(resource, field, values?.[field]));
  return parts.includes(null) ? null : JSON.stringify(parts);
}

module.exports = {
  RESOURCES, lookupKey, keyPart,
};
