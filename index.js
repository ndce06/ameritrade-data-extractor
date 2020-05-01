const puppeteer = require('puppeteer');
const fs = require('fs');
const dayjs = require('dayjs');
const XLSX = require('xlsx');
const prompt = require('prompt');

const LOGIN_URL = 'https://invest.ameritrade.com/grid/p/login';
const OPTION_CHAIN_URL = 'https://invest.ameritrade.com/cgi-bin/apps/u/OptionChain?symbol=SPXL&leg=symbol&type=CP&range=N&expire=A&tabid=0';
const OPTION_CHAIN_PARAMS = {
    symbol: 'SPXL',
    leg: 'symbol',
    type: 'CP',
    range: 'N',
    expire: 'A',
    tabid: '0'
};

const LOGIN_FORM = 'form.loginForm';
const USER_NAME = `${LOGIN_FORM} input[name=tbUsername]`;
const PASSWORD = `${LOGIN_FORM} input[name=tbPassword]`;

let username = '';
let password = '';
//
// Start the prompt
//
prompt.start();

const schema = {
    properties: {
        username: {
            description: 'Enter your username',
            required: true
        },
        password: {
            description: 'Enter your password',
            type: 'string',
            hidden: true,
            replace: '*',
            required: true
        }
    }
};

//
// Get two properties from the user: email, password
//
prompt.get(schema, async (err, result) => {
    if (err) {
        return onErr(err);
    }
    //
    // Log the results.
    //
    console.log('Thank you!! Your input received');

    console.log('Openning browser....');
    username = result.username;
    password = result.password;
    main();
});

function onErr(err) {
    console.log(err);
    return 1;
}

async function main() {
    const browser = await puppeteer.launch({ headless: false, slowMo: 150 })
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 800 })
    try {
        // Login
        await doLogin(page);
        // Go to Option chain
        await doOptionChain(page);

    } catch (e) {
        console.error(e);
    } finally {
        await browser.close()
    }
}

async function doLogin(page) {
    await page.goto(LOGIN_URL)

    const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded' })


    await page.waitForSelector(USER_NAME);
    await page.type(USER_NAME, username);

    await page.waitForSelector(PASSWORD, { visible: true });
    await page.type(PASSWORD, password);
    await page.screenshot({ path: './screenshots/login.png' });

    const loginRequest = page.waitForRequest('https://invest.ameritrade.com/grid/m/login');
    await page.evaluate(() => document.querySelector('form.loginForm input[type=submit]').click())

    await loginRequest;

    const loginError = await page.$('.loginError .message').catch((e) => console.log('no login error found', e));
    if (loginError !== null) {
        await page.screenshot({ path: './screenshots/login-error.png' });
        throw 'Login Failed';
    } else {
        await navigationPromise;
        await page.screenshot({ path: './screenshots/login-success.png' });
    }
}


async function doOptionChain(page) {
    //'file:///F:/Project/ameritrade-data-extractor/optionChain/index.html'
    await page.goto(OPTION_CHAIN_URL);

    const result = await page.$$eval('table.ocTable', tbls => Array.from(tbls).map(tbl => {
        const trCalls = Array.from(tbl.querySelectorAll('table.t0')[0].querySelectorAll('tr')).slice(1);
        const trStrike = Array.from(tbl.querySelectorAll('table.strike')[0].querySelectorAll('tr')).slice(1);
        const trPuts = Array.from(tbl.querySelectorAll('table.t0')[1].querySelectorAll('tr')).slice(1);
        const quote = tbl.querySelector('.tdQuote').textContent.toString().trim();

        const headerRow = ['', 'calls', '',
            'bid', '',
            'ask', '',
            'last', '',
            'change', '',
            'vol', '',
            'opInt', ''
        ];

        const convertToNumber = (str) => {
            str = str.toString().trim();
            if (isNaN(str)) {
                return str
            }

            return parseFloat(str);
        }

        const trDataExtractor = (tr, i) => {
            const tds = tr.querySelectorAll('td');
            let obj = {};


            for (let indx = 0; indx < headerRow.length; indx++) {
                if (indx % 2 === 1) {
                    obj[headerRow[indx]] = convertToNumber(tds[indx].textContent);
                }
            }

            obj['strike'] = convertToNumber(trStrike[i].querySelector('td').textContent);
            obj['mid'] = (obj.bid + obj.ask) / 2;
            return obj;
        }

        return {
            quote,
            calls: trCalls.map(trDataExtractor),
            puts: trPuts.map(trDataExtractor)
        };

    }));

    let data = [];
    let symbol = 'symbol';
    result.forEach((d) => {
        const quote = d.quote;
        const quoteArr = quote.split(' ');
        const dtstr = quoteArr.splice(quoteArr.length - 3, quoteArr.length - 1).join(' ');
        const expDate = dayjs(dtstr);
        const nowDate = dayjs();
        const expDays = expDate.diff(nowDate, "day");
        symbol = quote.replace(dtstr, '').trim();

        data = [
            ...data,
            ...d.calls.map((c) => {
                return {
                    ...c,
                    expDate: expDate.format('MM/DD/YYYY'),
                    expDays,
                    opType: 'C'
                };
            }),
            ...d.puts.map((p) => {
                return {
                    ...p,
                    expDate: expDate.format('MM/DD/YYYY'),
                    expDays,
                    opType: 'P'
                };
            })
        ];
    })

    console.log(`${data.length} records found`)
    fs.writeFileSync('./reports/data.json', JSON.stringify({ data }, null, 2));

    /* make the worksheet */
    const ws = XLSX.utils.json_to_sheet(data, {
        header: [
            "calls",
            "bid",
            "ask",
            "last",
            "change",
            "vol",
            "opInt",
            "strike",
            "mid",
            "expDate",
            "expDays",
            "opType"
        ]
    });

    /* add to workbook */
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, symbol);

    /* write workbook */
    XLSX.writeFile(wb, './reports/data.xlsx');
    await page.screenshot({ path: './screenshots/option-chain.png' });
}
