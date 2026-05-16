const { createClient } =  require('@supabase/supabase-js');

const supabaseUrl = 'https://xkihdfsydczmejncouqv.supabase.co';
const supabaseKey = 'sb_secret_LurSsgq5oTv8_4VB4vgLKA_fkRsnPow';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;