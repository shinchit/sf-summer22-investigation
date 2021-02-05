/* 最大取得レコード数 */
const maxFetch = 50000;
/* fetchの最大リトライ数 */
const timesOfRetry = 5;
/* 廃止予定のAPIバージョンの最大値 */
const deprecatedApiVersion = '30.0';
/* 調査対象の最古のログの作成び */
const mostOldestCreatedDate = 'LAST_N_DAYS:30';
/* 結果ファイル（CSV）に抽出する項目 */
const retrivedFields = ['EVENT_TYPE', 'TIMESTAMP', 'USER_ID', 'URI', 'API_TYPE', 'API_VERSION', 'CLIENT_NAME', 'METHOD_NAME', 'ENTITY_NAME'];
/* Salesforce接続情報 */
const isProduction = true;  /* 本番環境に接続するならtrue、Sandboxに接続するならfalseを指定する */
const sf_account = '<SalesforceのログインID>';
const sf_password = '<Salesforceのログインパスワード>' + '<Salesforceのセキュリティトークン>';
const sf_env = 'https://' + ( isProduction ? 'login' : 'test' ) + '.salesforce.com';

const fetch = require('node-fetch');
const jsforce = require('jsforce');
const lodash = require('lodash');
const csv = require('csv');
const Json2csvParser = require('json2csv').Parser;
const stream = require('stream');
const conn = new jsforce.Connection({
  loginUrl: sf_env
});
const fetch_retry = async (url, options, n) => {
  try {
    return await fetch(url, options);
  } catch (err) {
    await new Promise(r => setTimeout(r, 1000));
    if (n === 1) throw err;
    return await fetch_retry(url, options, n - 1);
  }
};
const isLogsCountOnly = ( lodash.size(process.argv) >= 3 && process.argv[2] === "logs-count-only" ) ? true : false;

main();

function login() {
  return new Promise(function(resolve, reject) {
    conn.login(sf_account, sf_password, function(err, res) {
      if (err) {
        reject(err);
      }
      resolve();
    });
  });
}

/* 作成日時がmostOldestCreatedDate以降のEventLogiFile を取得する */
function getEventLogs() {
  return new Promise(function(resolve, reject) {
    let records = [];
    let query = conn.query("SELECT LogFile, EventType, CreatedDate FROM EventLogFile WHERE EventType IN ('API', 'RestApi') AND CreatedDate >= " + mostOldestCreatedDate + " ORDER BY CreatedDate DESC")
      .on("record", function(record) {
        records.push(record);
      })
      .on("end", function() {
        resolve(records);
      })
      .on("error", function(err) {
        console.error(err);
        reject(err);
      })
      .run({ autoFetch : true, maxFetch : maxFetch });
  });
}

/* オブジェクトJSONに整形して返す */
function pre(obj) {
  return JSON.stringify(obj, null, 2);
}

/* main */
async function main() {
  try {
    // CSVのヘッダを出力
    if ( ! isLogsCountOnly ) {
      console.log(lodash.join(retrivedFields, ','));
    }

    // EventLog を解析してAPIバージョンが deprecatedApiVersion 以下のものがあったらCSVのボディとして出力する
    await login();
    const event_logs = await getEventLogs();
    const logs = lodash.map(event_logs, (event_log) => {
      return event_log.attributes.url;
    });
    if ( isLogsCountOnly ) { // EventLogsのカウントだけ行う場合は、カウント数を表示して処理を抜ける
      console.log('count of logs: ' + lodash.size(logs));
      return;
    }
    for (let i = 0; i < lodash.size(logs); i++ ) {
      fetch_retry(conn.instanceUrl + logs[i] + '/LogFile', {
        headers: {
          'Authorization': 'Bearer ' + conn.accessToken,
          'X-PrettyPrint': '1'
        }
      }, timesOfRetry)
        .then(res => res.text())
        .then((body) => {
          stream.Readable.from(body)
            .pipe(csv.parse({columns: true}, (err, data) => {
              let deprecated_versions = lodash.filter(data, (item) => {
                if ( item['EVENT_TYPE'] === 'API' ) {
                  // SOAP / API EventType
                  const api_version = parseInt(item['API_VERSION']);
                  return ( item['API_TYPE'] === 'E' || item['API_TYPE'] === 'P' ) && api_version <= deprecatedApiVersion;
                } else if ( item['EVENT_TYPE'] === 'RestApi' ) {
                  // REST / RestApi EventType
                  // URIに/v30.0以下が含まれるエンドポイントを特定する
                  const uri = item['URI'];
                  if ( uri !== '' ) {
                    const regex = /\/v(\d+\.\d*)\/*/;
                    const result = uri.match(regex);
                    const api_version = parseInt(result[1]);
                    return api_version <= deprecatedApiVersion;
                  } else {
                    return false;
                  }
                } else {
                  return false;
                }
              });
              if (lodash.size(deprecated_versions) > 0) {
                deprecated_versions = lodash.map(deprecated_versions, (item) => {
                  const retrivedData = {};
                  lodash.forEach(retrivedFields, (field) => {
                    retrivedData[field] = item[field];
                  });
                  return retrivedData;
                });
                const json2csvParser = new Json2csvParser({ retrivedFields, header: false });
                const csv = json2csvParser.parse(deprecated_versions);
                console.log(csv);
              }
            }));
        });
    }
  } catch(err) {
    console.log(err);
  }
}
