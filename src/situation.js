import { ERROR_MESSAGES } from "./error.js";
import { units } from "./units.js";
/** ==========================================
 * 2. グローバル変数とタイマー制御
 * 【目的】現在の状態管理およびボタン長押しによる連続入力制御のため
 * ========================================== */
// 現在画面に表示・管理されている戦況オブジェクト
let currentSituation = null;
// 調整ボタン（＋/ー）を長押しした際の連続自動入力用のタイマーID
let adjustButtonRepeatTimerId = null;
// 追加・変更：4つの機体のマップ座標、ベクトルの向き、および矢印の表示ON/OFF状態
const mapPositions = {
    self: { x: 30, y: 30, vx: 0, vy: 12, visible: true },
    partner: { x: 45, y: 30, vx: 0, vy: 12, visible: true },
    enemy1: { x: 65, y: 70, vx: 0, vy: -12, visible: true },
    enemy2: { x: 80, y: 70, vx: 0, vy: -12, visible: true },
};
/**
 * 【機能】調整ボタンの長押し（連続入力）を停止する
 * 【何のために】ユーザーがボタンから指を離した際、数値の自動増減を安全に止めるため
 */
function stopAdjustButtonRepeat() {
    if (adjustButtonRepeatTimerId === null) {
        return;
    }
    window.clearInterval(adjustButtonRepeatTimerId);
    adjustButtonRepeatTimerId = null;
}
/** ==========================================
 * 3. ユーティリティ・計算ロジック
 * 【目的】乱数生成や機体のランダム選出、ゲーム独自の各種計算を行うため
 * ========================================== */
/**
 * 【機能】指定範囲のランダムな整数を取得する
 * 【何のために】撃墜数やダメージ、残りHPなどのシチュエーションをランダムに算出するため
 */
function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}
/**
 * 【機能】機体リストから重複なしで指定数の機体をランダムに選出する
 * 【何のために】対戦カード（4機）を毎回ランダムに決定するため
 */
function pickUniqueUnitsFromList(unitList, count) {
    if (count > unitList.length) {
        throw new Error(ERROR_MESSAGES.unitCountExceeded);
    }
    const copiedUnits = [...unitList];
    const selectedUnits = [];
    for (let i = 0; i < count; i++) {
        const index = randomInt(0, copiedUnits.length - 1);
        const unit = copiedUnits[index];
        if (unit === undefined) {
            throw new Error(ERROR_MESSAGES.unitSelectFailed);
        }
        selectedUnits.push(unit);
        copiedUnits.splice(index, 1); // 選出した機体をリストから除外（重複防止）
    }
    return selectedUnits;
}
/**
 * 【機能】各種戦闘履歴から現在の「覚醒ゲージ（0〜200）」を精密に計算する
 * 【何のために】被ダメージ、撃墜された補償、相方の撃墜、与ダメージを元に原作さながらのゲージ量を割り出すため
 */
function calculateBurstGauge(hp, currentMaxHp, unitMaxHp, ownDeaths, partnerDeaths, dealtDamage) {
    const currentLifeLostHp = currentMaxHp - hp; // 現在のライフでの減少分
    const deathLostHp = unitMaxHp * ownDeaths; // 過去に撃墜されて失った総HP
    // 各種要素によるゲージ上昇率の計算（換算レート）
    const currentLifeDamageBurst = (currentLifeLostHp / currentMaxHp) * 110;
    const deathDamageBurst = (deathLostHp / unitMaxHp) * 110;
    const ownDeathBurst = ownDeaths * 60;
    const partnerDeathBurst = partnerDeaths * 18;
    const dealtDamageBurst = dealtDamage * 0.06;
    const totalBurst = currentLifeDamageBurst +
        deathDamageBurst +
        ownDeathBurst +
        partnerDeathBurst +
        dealtDamageBurst;
    return Math.min(200, Math.floor(totalBurst)); // 最大値は200（2回分）に制限
}
/**
 * 【機能】初期のプレイヤー状態（PlayerState）オブジェクトを生成する
 * 【何のために】機体やHPなどの情報から、自動的に覚醒ゲージ等も内包したプレイヤーデータを組み立てるため
 */
function createPlayerState(unit, hp, currentMaxHp, ownDeaths, partnerDeaths, dealtDamage) {
    return {
        unit,
        hp,
        currentMaxHp,
        burstGauge: calculateBurstGauge(hp, currentMaxHp, unit.maxHp, ownDeaths, partnerDeaths, dealtDamage),
        deaths: ownDeaths,
        partnerDeaths,
        dealtDamage,
        overLimitStatus: "unused",
    };
}
/**
 * 【機能】チームの残りコストを計算する
 * 【何のために】初期コスト6000から、各機体が撃墜された分のコストを差し引くため
 */
function calculateRemainingCost(unit1, deaths1, unit2, deaths2) {
    return 6000 - unit1.cost * deaths1 - unit2.cost * deaths2;
}
/**
 * 【機能】再出撃（リスポーン）時の最大HPを計算する
 * 【何のために】チームの残りコストが機体のコストを下回っている場合（コストオーバー）、その割合に応じて最大HPを減らすため
 */
function calculateRespawnMaxHp(unit, remainingCostAfterDeath) {
    if (remainingCostAfterDeath >= unit.cost) {
        return unit.maxHp; // コストが足りていれば満タンで復帰
    }
    // コストオーバー時は残りコストの割合に応じて最大HPが減少する（最低値は1）
    return Math.max(1, Math.floor(unit.maxHp * (remainingCostAfterDeath / unit.cost)));
}
/**
 * 【機能】コストオーバーを考慮してプレイヤーの「現在最大HP」を更新し、現在HPをその枠内に丸める
 * 【何のために】ユーザー操作で撃墜数が変わった際、コスト状況に応じた最大HPの増減を即座に反映するため
 */
function updateCostOverHpLimitForPlayer(playerKey) {
    if (currentSituation === null) {
        return;
    }
    const player = currentSituation[playerKey];
    const teamCost = playerKey === "self" || playerKey === "partner"
        ? currentSituation.allyTeamCost
        : currentSituation.enemyTeamCost;
    if (player.deaths === 0) {
        player.currentMaxHp = player.unit.maxHp; // 0回撃墜ならペナルティなし
    }
    else {
        player.currentMaxHp = calculateRespawnMaxHp(player.unit, teamCost);
    }
    // 最大HPが下がった結果、現在HPが最大HPを上回らないように調整
    player.hp = clampValue(player.hp, 1, player.currentMaxHp);
}
/**
 * 【機能】両プレイヤーの撃墜数から、ランダムな撃墜順序の配列を作成する
 * 【何のために】どちらが先に落ちたかによって最終的なコストオーバーの対象（最後に落ちた方）が変わるため、それを再現するため
 */
function createDeathOrder(deaths1, deaths2) {
    const deathOrder = [];
    for (let i = 0; i < deaths1; i++)
        deathOrder.push("unit1");
    for (let i = 0; i < deaths2; i++)
        deathOrder.push("unit2");
    // フィッシャー–イェーツのシャッフルアルゴリズムで撃墜順をランダムに並び替える
    for (let i = deathOrder.length - 1; i > 0; i--) {
        const randomIndex = randomInt(0, i);
        const current = deathOrder[i];
        const random = deathOrder[randomIndex];
        if (current === undefined || random === undefined) {
            throw new Error(ERROR_MESSAGES.unitSelectFailed);
        }
        deathOrder[i] = random;
        deathOrder[randomIndex] = current;
    }
    return deathOrder;
}
/**
 * 【機能】チーム内の2機の機体から、矛盾のない整合性の取れたランダムな戦闘状況（HP・撃墜数）をシミュレートして生成する
 * 【何のために】コストが0以下（敗北状態）になっていない適法な戦況パターンを最大20回の試行で見つけ出すため
 */
function createTeamBaseSituation(unit1, unit2) {
    for (let i = 0; i < 20; i++) {
        const deaths1 = randomInt(0, 3);
        const deaths2 = randomInt(0, 3);
        const deathOrder = createDeathOrder(deaths1, deaths2);
        let remainingCost = 6000;
        let unit1CurrentMaxHp = unit1.maxHp;
        let unit2CurrentMaxHp = unit2.maxHp;
        let isValid = true;
        // 撃墜順に沿ってチームコストと復活時最大HPをシミュレーション
        for (const fallenUnit of deathOrder) {
            if (fallenUnit === "unit1") {
                remainingCost -= unit1.cost;
                if (remainingCost <= 0) {
                    isValid = false;
                    break;
                } // コストが尽きたらその時点でゲームオーバーなので無効な戦況
                unit1CurrentMaxHp = calculateRespawnMaxHp(unit1, remainingCost);
            }
            if (fallenUnit === "unit2") {
                remainingCost -= unit2.cost;
                if (remainingCost <= 0) {
                    isValid = false;
                    break;
                }
                unit2CurrentMaxHp = calculateRespawnMaxHp(unit2, remainingCost);
            }
        }
        // まだチームコストが残っている正常な戦況であれば採用
        if (isValid) {
            return {
                remainingCost,
                unit1Hp: randomInt(1, unit1CurrentMaxHp),
                unit2Hp: randomInt(1, unit2CurrentMaxHp),
                unit1CurrentMaxHp,
                unit2CurrentMaxHp,
                deaths1,
                deaths2,
            };
        }
    }
    // 20回やっても見つからなかった場合の安全なフォールバック（初期状態）
    return {
        remainingCost: 6000,
        unit1Hp: unit1.maxHp,
        unit2Hp: unit2.maxHp,
        unit1CurrentMaxHp: unit1.maxHp,
        unit2CurrentMaxHp: unit2.maxHp,
        deaths1: 0,
        deaths2: 0,
    };
}
/**
 * 【機能】チームがこれまでに受けた「総被ダメージ」を計算する
 * 【何のために】相手チームがこれまでに与えたはずの「総与ダメージ」の原資を割り出すため
 */
function calculateTotalReceivedDamage(unit1, unit2, teamBaseSituation) {
    const unit1CurrentLifeDamage = teamBaseSituation.unit1CurrentMaxHp - teamBaseSituation.unit1Hp;
    const unit2CurrentLifeDamage = teamBaseSituation.unit2CurrentMaxHp - teamBaseSituation.unit2Hp;
    const unit1DeathDamage = unit1.maxHp * teamBaseSituation.deaths1;
    const unit2DeathDamage = unit2.maxHp * teamBaseSituation.deaths2;
    return unit1CurrentLifeDamage + unit2CurrentLifeDamage + unit1DeathDamage + unit2DeathDamage;
}
/**
 * 【機能】総ダメージを、チーム内の2人にランダムに配分する
 * 【何のために】「チームが与えた総ダメージ」を、プレイヤー1とプレイヤー2の戦績（与ダメージ）へ自然に散らすため
 */
function createRandomDamageDistribution(totalDamage) {
    const player1Damage = randomInt(0, totalDamage);
    const player2Damage = totalDamage - player1Damage;
    return { player1Damage, player2Damage };
}
/**
 * 【機能】プレイヤーがオーバーリミットを発動できる状態かを判定する
 * 【何のために】チームの残りコストが、どちらの機体のコストをも下回っている状態（いわゆる詰みの状況など）かどうかをチェックするため
 */
function canActivateOverLimit(playerKey, situation) {
    if (playerKey === "self" || playerKey === "partner") {
        return (situation.allyTeamCost <= situation.self.unit.cost &&
            situation.allyTeamCost <= situation.partner.unit.cost);
    }
    return (situation.enemyTeamCost <= situation.enemy1.unit.cost &&
        situation.enemyTeamCost <= situation.enemy2.unit.cost);
}
/**
 * 【機能】全プレイヤーのオーバーリミット（覚醒）可能状態を一斉に更新する
 * 【何のために】コスト変動に伴い、発動可能になったプレイヤーのステータス（available / unused）を同期するため
 */
function updateOverLimitStatuses(situation) {
    const playerKeys = ["self", "partner", "enemy1", "enemy2"];
    for (const playerKey of playerKeys) {
        const player = situation[playerKey];
        if (player.overLimitStatus === "ended") {
            continue; // 既に「使用終了」している場合はスキップ
        }
        const isAvailable = canActivateOverLimit(playerKey, situation);
        player.overLimitStatus = isAvailable ? "available" : "unused";
        // アイコンに白い枠線を追加/削除
        const icon = document.querySelector(`.map-pin[data-player-key="${playerKey}"]`);
        if (icon instanceof HTMLElement) {
            if (isAvailable) {
                icon.classList.add("over-limit-active");
            }
            else {
                icon.classList.remove("over-limit-active");
            }
        }
    }
}
/**
 * 【機能】ゲーム全体の新しいランダム戦況（Situation）を完全に1から組み立てる
 * 【何のために】「ランダム生成」ボタンが押された際に、整合性のあるリアルな戦況データを新規作成するため
 */
function createSituation() {
    // 4機をランダム選出
    const [selfUnit, partnerUnit, enemyUnit1, enemyUnit2] = pickUniqueUnitsFromList(units, 4);
    if (!selfUnit || !partnerUnit || !enemyUnit1 || !enemyUnit2) {
        throw new Error(ERROR_MESSAGES.requiredUnitsNotSelected);
    }
    // 自チーム・敵チームのベース戦況をランダムシミュレート生成
    const allyBaseSituation = createTeamBaseSituation(selfUnit, partnerUnit);
    const enemyBaseSituation = createTeamBaseSituation(enemyUnit1, enemyUnit2);
    // 双方が食らった総ダメージを算出
    const allyReceivedDamage = calculateTotalReceivedDamage(selfUnit, partnerUnit, allyBaseSituation);
    const enemyReceivedDamage = calculateTotalReceivedDamage(enemyUnit1, enemyUnit2, enemyBaseSituation);
    // 「相手の総被ダメージ＝自分の総与ダメージ」としてスコアをプレイヤーに分配
    const allyDealtDamageDistribution = createRandomDamageDistribution(enemyReceivedDamage);
    const enemyDealtDamageDistribution = createRandomDamageDistribution(allyReceivedDamage);
    // 最終的なオブジェクトの組み立て
    const situation = {
        allyTeamCost: allyBaseSituation.remainingCost,
        enemyTeamCost: enemyBaseSituation.remainingCost,
        self: createPlayerState(selfUnit, allyBaseSituation.unit1Hp, allyBaseSituation.unit1CurrentMaxHp, allyBaseSituation.deaths1, allyBaseSituation.deaths2, allyDealtDamageDistribution.player1Damage),
        partner: createPlayerState(partnerUnit, allyBaseSituation.unit2Hp, allyBaseSituation.unit2CurrentMaxHp, allyBaseSituation.deaths2, allyBaseSituation.deaths1, allyDealtDamageDistribution.player2Damage),
        enemy1: createPlayerState(enemyUnit1, enemyBaseSituation.unit1Hp, enemyBaseSituation.unit1CurrentMaxHp, enemyBaseSituation.deaths1, enemyBaseSituation.deaths2, enemyDealtDamageDistribution.player1Damage),
        enemy2: createPlayerState(enemyUnit2, enemyBaseSituation.unit2Hp, enemyBaseSituation.unit2CurrentMaxHp, enemyBaseSituation.deaths2, enemyBaseSituation.deaths1, enemyDealtDamageDistribution.player2Damage),
    };
    updateOverLimitStatuses(situation);
    return situation;
}
/** ==========================================
 * 4. UI表現（CSSクラス・HTML要素生成）
 * 【目的】データの状態に応じた適切なスタイルや要素を生成するため
 * ========================================== */
/**
 * 【機能】HPの残量割合に応じたHPバーのカラーCSSクラス名を返す
 * 【何のために】HPが「緑(70%以上)」「黄(30%以上)」「赤(30%未満)」と、視覚的にピンチ度合いがわかるようにするため
 */
function getHpBarClassName(hp, maxHp) {
    const hpRate = hp / maxHp;
    if (hpRate >= 0.7)
        return "hp-bar-fill-green";
    if (hpRate >= 0.3)
        return "hp-bar-fill-yellow";
    return "hp-bar-fill-red";
}
/**
 * 【機能】覚醒ゲージの量に応じたバーのカラーCSSクラス名を返す
 * 【何のために】1回分(100%)貯まっているか、2回分(200%)満タンかでバーの色（半透明・フル状態）を変えるため
 */
function getBurstBarClassName(burstGauge) {
    if (burstGauge >= 200)
        return "burst-bar-fill-full";
    if (burstGauge >= 100)
        return "burst-bar-fill-half";
    return "burst-bar-fill-none";
}
/**
 * 【機能】機体選択用セレクトボックスの `<option>` 要素を生成する
 * 【何のために】プルダウンメニューに機体名とコストを表示し、現在選択中の機体をアクティブ(selected)にするため
 */
function createUnitOptionElement(unit, selectedUnitName) {
    const option = document.createElement("option");
    option.value = unit.name;
    option.textContent = `${unit.name}（${unit.cost}）`;
    option.selected = unit.name === selectedUnitName;
    return option;
}
/**
 * 【機能】HTMLから `<template>` 要素を取得・検証して返す
 * 【何のために】コスト行やプレイヤーカードのHTML構造のひな形を安全にクローンして再利用するため
 */
function getTemplateElement(templateId) {
    const template = document.getElementById(templateId);
    if (!(template instanceof HTMLTemplateElement)) {
        throw new Error(`${templateId} が見つかりません`);
    }
    return template;
}
/**
 * 【機能】指定されたIDを持つDOM要素を「必須要素」として安全に取得する
 * 【何のために】HTML側に該当する描画エリアが存在しない場合、即座にエラーを投げてバグを検知するため
 */
function getRequiredElementById(elementId, errorMessage) {
    const element = document.getElementById(elementId);
    if (!(element instanceof HTMLElement)) {
        throw new Error(errorMessage);
    }
    return element;
}
/**
 * 【機能】指定されたDOM要素の中身（子要素）を完全にクリアする
 * 【何のために】再レンダリングする際、古い表示内容が重複して残らないように初期化するため
 */
function clearElement(element) {
    element.replaceChildren();
}
/**
 * 【機能】チームコストを表示するゲージ行要素（HTML）を作成する
 * 【何のために】自軍・敵軍の残りコストを、500コスト刻みの目盛り（セグメント）付きバーとして視覚化するため
 */
function createCostRowElement(label, cost, teamClassName) {
    const template = getTemplateElement("cost-row-template");
    const fragment = template.content.cloneNode(true);
    if (!(fragment instanceof DocumentFragment)) {
        throw new Error("コスト行テンプレートの複製に失敗しました");
    }
    const row = fragment.querySelector(".exvs-cost-row");
    if (!(row instanceof HTMLElement))
        throw new Error("コスト行要素が見つかりません");
    row.classList.add(teamClassName);
    const labelElement = row.querySelector(".exvs-cost-label");
    const barElement = row.querySelector(".exvs-cost-bar");
    const valueElement = row.querySelector(".exvs-cost-value");
    if (!(labelElement instanceof HTMLElement) || !(barElement instanceof HTMLElement) || !(valueElement instanceof HTMLElement)) {
        throw new Error("コスト行の構成要素が見つかりません");
    }
    const maxCost = 6000;
    const unitCost = 500;
    const segmentCount = maxCost / unitCost; // 総セグメント数 (12個)
    const activeSegmentCount = Math.ceil(cost / unitCost); // 残りコストに応じたアクティブ数
    labelElement.textContent = label;
    valueElement.textContent = String(cost);
    // 12個の目盛りを生成し、残りコスト分に「is-active」クラスを付与
    for (let index = 0; index < segmentCount; index++) {
        const segment = document.createElement("span");
        segment.classList.add("cost-segment");
        if (index < activeSegmentCount) {
            segment.classList.add("is-active");
        }
        barElement.appendChild(segment);
    }
    return row;
}
/**
 * 【機能】自軍と敵軍両方のコストエリアをまとめた親要素を生成する
 * 【何のために】画面上部のチームコストUIを一括で構築するため
 */
function createTeamStatusElement(situation) {
    const area = document.createElement("div");
    area.classList.add("exvs-cost-area");
    area.appendChild(createCostRowElement("自チーム", situation.allyTeamCost, "ally-cost"));
    area.appendChild(createCostRowElement("敵チーム", situation.enemyTeamCost, "enemy-cost"));
    return area;
}
/** ==========================================
 * 5. UIへのデータ埋め込み（データバインディング）
 * 【目的】各プレイヤーカードのHTML要素に、プログラム内のデータ状態をマッピングするため
 * ========================================== */
/**
 * 【機能】HTML要素内の操作部品へ、データ属性 `data-player-key` をセットする
 * 【何のために】入力フォームやボタンがイベントを検知した際、それが「誰（self/partner等）」の操作なのか判別可能にするため
 */
function setPlayerKeyToElements(card, playerKey) {
    const playerKeyElements = card.querySelectorAll(".unit-card-select, .adjust-input, .adjust-button, .over-limit-select");
    playerKeyElements.forEach((element) => {
        if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement || element instanceof HTMLSelectElement) {
            element.dataset.playerKey = playerKey;
        }
    });
}
/**
 * 【機能】プレイヤーの撃墜数や与ダメージを入力フォーム（input）の値にセットする
 * 【何のために】現在の数値をテキストボックス等の画面表示に同期させるため
 */
function setPlayerInputValues(card, player) {
    const inputs = card.querySelectorAll(".adjust-input");
    inputs.forEach((input) => {
        if (!(input instanceof HTMLInputElement))
            return;
        if (input.dataset.field === "deaths") {
            input.value = String(player.deaths);
        }
        if (input.dataset.field === "dealtDamage") {
            input.value = String(player.dealtDamage);
        }
    });
}
/**
 * 【機能】機体選択のプルダウンメニューを構築し、現在値を反映する
 * 【何のために】全機体のリストをセレクトボックスの子要素として全投入し、選択中機体を選択状態にするため
 */
function setPlayerUnitSelect(card, player) {
    const unitSelect = card.querySelector(".unit-card-select");
    if (!(unitSelect instanceof HTMLSelectElement))
        throw new Error("機体選択要素が見つかりません");
    unitSelect.replaceChildren();
    for (const unit of units) {
        unitSelect.appendChild(createUnitOptionElement(unit, player.unit.name));
    }
}
/**
 * 【機能】耐久値（HP）のテキストおよびプログレスバーを更新する
 * 【何のために】「現在のHP / 元の最大HP」というテキストと、残量に応じたバーの長さ、適切な色を画面に反映するため
 */
function setPlayerHpArea(card, player) {
    const hpValue = card.querySelector(".hp-inline-value");
    const hpBarFill = card.querySelector(".hp-bar-fill");
    if (!(hpValue instanceof HTMLElement) || !(/hp-bar-fill/.test(hpBarFill?.className || ""))) {
        throw new Error("耐久関連の表示要素が見つかりません");
    }
    const hpBarWidth = (player.hp / player.unit.maxHp) * 100;
    hpValue.textContent = `${player.hp} / ${player.unit.maxHp}`;
    hpBarFill.className = `hp-bar-fill ${getHpBarClassName(player.hp, player.unit.maxHp)}`;
    hpBarFill.style.width = `${hpBarWidth}%`;
}
/**
 * 【機能】覚醒値（Burst）のテキストおよびプログレスバーを更新する
 * 【何のために】覚醒パーセンテージ（最大200%）を算出し、ゲージの幅と色を同期するため
 */
function setPlayerBurstArea(card, player) {
    const burstValue = card.querySelector(".burst-inline-value");
    const burstBarFill = card.querySelector(".burst-bar-fill");
    if (!(burstValue instanceof HTMLElement) || !(burstBarFill instanceof HTMLElement)) {
        throw new Error("覚醒値表示要素が見つかりません");
    }
    const burstBarWidth = (player.burstGauge / 200) * 100;
    burstValue.textContent = `${Math.floor(player.burstGauge)}%`;
    burstBarFill.className = `burst-bar-fill ${getBurstBarClassName(player.burstGauge)}`;
    burstBarFill.style.width = `${burstBarWidth}%`;
}
/**
 * 【機能】オーバーリミット（覚醒）の選択セレクトボックスの値を同期する
 * 【何のために】データ上のオーバーリミット状況（利用可能、未使用など）をプルダウンの表示に合わせるため
 */
function setPlayerOverLimitArea(card, player) {
    const overLimitSelect = card.querySelector(".over-limit-select");
    if (!(overLimitSelect instanceof HTMLSelectElement))
        throw new Error("オーバーリミット選択要素が見つかりません");
    overLimitSelect.value = player.overLimitStatus;
}
/**
 * 【機能】1人分のプレイヤーカード要素（HTML）を構築して返す
 * 【何のために】テンプレートを複製し、各ステータス領域（HP、覚醒、機体選出など）のデータマッピング処理をまとめて実行するため
 */
function createPlayerElement(playerKey, player, teamClassName) {
    const template = getTemplateElement("player-card-template");
    const fragment = template.content.cloneNode(true);
    if (!(fragment instanceof DocumentFragment))
        throw new Error("テンプレート複製失敗");
    const card = fragment.querySelector(".card");
    if (!(card instanceof HTMLElement))
        throw new Error("プレイヤーカード要素が見つかりません");
    card.classList.add(teamClassName); // 自チームか敵チームかで背景枠の色などを変えるクラスを付与
    // 各種バインディング処理の実行
    setPlayerKeyToElements(card, playerKey);
    setPlayerInputValues(card, player);
    setPlayerUnitSelect(card, player);
    setPlayerHpArea(card, player);
    setPlayerBurstArea(card, player);
    setPlayerOverLimitArea(card, player);
    return card;
}
/**
 * 【機能】4人の全プレイヤーカードを内包したDOMフラグメントを作成する
 * 【何のために】画面にまとめて追加する際、DOMへの追加回数を1回に抑えてレンダリングパフォーマンスを向上させるため
 */
function createSituationFragment(situation) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(createPlayerElement("self", situation.self, "ally-card"));
    fragment.appendChild(createPlayerElement("partner", situation.partner, "ally-card"));
    fragment.appendChild(createPlayerElement("enemy1", situation.enemy1, "enemy-card"));
    fragment.appendChild(createPlayerElement("enemy2", situation.enemy2, "enemy-card"));
    return fragment;
}
/** ==========================================
 * 6. ユーザー操作に伴う状態更新・再計算
 * 【目的】画面操作によって変更された数値を処理し、連動する数値を自動再計算するため
 * ========================================== */
/**
 * 【機能】数値を最小値・最大値の範囲内に収める（クランプ処理）
 * 【何のために】HPがマイナスになったり、最大HPを超えたり、覚醒ゲージが200%を超えないようにバリデーションするため
 */
function clampValue(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
/**
 * 【機能】特定のプレイヤーの覚醒ゲージを単体で再計算する
 * 【何のために】HP増減や撃墜数増減ののち、最新のステータスを元に覚醒ゲージを連動更新するため
 */
function recalculatePlayerBurstGauge(player) {
    player.burstGauge = calculateBurstGauge(player.hp, player.currentMaxHp, player.unit.maxHp, player.deaths, player.partnerDeaths, player.dealtDamage);
}
/**
 * 【機能】お互いの「相方の撃墜数(partnerDeaths)」を現在のデータから相互に同期する
 * 【何のために】自分の撃墜数(deaths)が変わった際、相方側のデータが持っている「相方の撃墜数」へ強制的に同期させ、覚醒計算の破綻を防ぐため
 */
function syncPartnerDeaths() {
    if (currentSituation === null)
        return;
    currentSituation.self.partnerDeaths = currentSituation.partner.deaths;
    currentSituation.partner.partnerDeaths = currentSituation.self.deaths;
    currentSituation.enemy1.partnerDeaths = currentSituation.enemy2.deaths;
    currentSituation.enemy2.partnerDeaths = currentSituation.enemy1.deaths;
}
/**
 * 【機能】全4プレイヤーの覚醒ゲージを一斉に再計算する
 * 【何のために】戦況が大きく変わったタイミングで全体の覚醒ゲージをクリーンに揃えるため
 */
function recalculateAllBurstGauges(situation) {
    recalculatePlayerBurstGauge(situation.self);
    recalculatePlayerBurstGauge(situation.partner);
    recalculatePlayerBurstGauge(situation.enemy1);
    recalculatePlayerBurstGauge(situation.enemy2);
}
/**
 * 【機能】撃墜数などの変更を受け、チームコストや付随する全ステータスを再計算する
 * 【何のために】コスト変動の全連動処理（コストオーバーによる最大HP低下、相方の撃墜数更新、覚醒ゲージ再計算、オーバーリミット可否）を一連の流れで正しく処理するため
 */
function recalculateTeamCosts(costOverTargetPlayerKey, shouldRecalculateBurst = true) {
    if (currentSituation === null)
        return;
    // 自軍・敵軍の残りチームコストを再計算
    currentSituation.allyTeamCost = Math.max(0, calculateRemainingCost(currentSituation.self.unit, currentSituation.self.deaths, currentSituation.partner.unit, currentSituation.partner.deaths));
    currentSituation.enemyTeamCost = Math.max(0, calculateRemainingCost(currentSituation.enemy1.unit, currentSituation.enemy1.deaths, currentSituation.enemy2.unit, currentSituation.enemy2.deaths));
    // 指定されたプレイヤーがいれば、コストオーバーによるHP上限変化を適用
    if (costOverTargetPlayerKey !== undefined) {
        updateCostOverHpLimitForPlayer(costOverTargetPlayerKey);
    }
    syncPartnerDeaths();
    if (shouldRecalculateBurst) {
        recalculateAllBurstGauges(currentSituation);
    }
    updateOverLimitStatuses(currentSituation);
}
/**
 * 【機能】指定プレイヤーの覚醒ゲージを加算（または減算）する
 * 【何のために】撃墜された際の一時的なゲージボーナス付与などを処理するため（0〜200に丸める）
 */
function addBurstGauge(player, value) {
    player.burstGauge = clampValue(player.burstGauge + value, 0, 200);
}
/**
 * 【機能】指定されたプレイヤーの「相方」にあたるPlayerKeyを特定する
 * 【何のために】誰かが撃墜された際に、その「相方」の覚醒ゲージをボーナス上昇させる対象を特定するため
 */
function getPartnerKey(playerKey) {
    if (playerKey === "self")
        return "partner";
    if (playerKey === "partner")
        return "self";
    if (playerKey === "enemy1")
        return "enemy2";
    return "enemy1";
}
/**
 * 【機能】プレイヤーの撃墜数(deaths)が手動変更された際の特殊連動ロジック
 * 【何のために】撃墜数が増えた（＝落ちた）場合はその時点のHPに応じた覚醒ゲージ加算＆相方への覚醒18%付与を行い、撃墜数が減った（＝巻き戻した）場合は覚醒ペナルティ減算を行った上で、HPをリスポーン時の最大値へ全回復させるため
 */
function updateDeathCount(playerKey, nextDeaths) {
    if (currentSituation === null)
        return;
    const player = currentSituation[playerKey];
    const partner = currentSituation[getPartnerKey(playerKey)];
    const previousDeaths = player.deaths;
    const fixedNextDeaths = clampValue(nextDeaths, 0, 3);
    const deathDifference = fixedNextDeaths - previousDeaths;
    if (deathDifference === 0)
        return;
    if (deathDifference > 0) {
        // 撃墜数が増加した：残っていたHP減少分に応じた覚醒＋一律60%を獲得、相方は一律18%獲得
        const currentHpDamageBurst = (player.hp / player.unit.maxHp) * 110;
        const ownDeathBurst = 60;
        addBurstGauge(player, currentHpDamageBurst + ownDeathBurst);
        addBurstGauge(partner, 18);
    }
    if (deathDifference < 0) {
        // 撃墜数が減少した（デバッグ操作等）：獲得したであろうゲージを差し引く（ペナルティ）
        addBurstGauge(player, -170);
        addBurstGauge(partner, -18);
    }
    player.deaths = fixedNextDeaths;
    partner.partnerDeaths = player.deaths;
    // 撃墜数変更に伴うコストとコストオーバー計算（覚醒ゲージは上部で個別に計算しているため第2引数はfalse）
    recalculateTeamCosts(playerKey, false);
    // 復活した扱いとしてHPを最大値に設定
    player.hp = player.currentMaxHp;
}
/**
 * 【機能】手動操作で変更されたフィールド（項目）に応じてプレイヤーの内部データを個別更新する
 * 【何のために】撃墜数、相方撃墜数、与ダメージ、HP、覚醒ゲージのどれが変更されたかを切り分け、それぞれの計算レートに基づいて覚醒ゲージ等を連動更新するため
 */
function updatePlayerField(playerKey, field, value) {
    if (currentSituation === null)
        return;
    const player = currentSituation[playerKey];
    if (field === "deaths") {
        updateDeathCount(playerKey, value);
        return;
    }
    if (field === "partnerDeaths") {
        player.partnerDeaths = clampValue(value, 0, 3);
        recalculateTeamCosts();
        return;
    }
    if (field === "dealtDamage") {
        const previousDealtDamage = player.dealtDamage;
        const nextDealtDamage = clampValue(value, 0, 2000);
        const damageDifference = nextDealtDamage - previousDealtDamage;
        const burstDifference = damageDifference * 0.06; // 与ダメージによる覚醒ゲージ増加レート
        player.dealtDamage = nextDealtDamage;
        player.burstGauge = clampValue(player.burstGauge + burstDifference, 0, 200);
        return;
    }
    if (field === "hp") {
        const previousHp = player.hp;
        const nextHp = clampValue(value, 1, player.currentMaxHp);
        const damage = previousHp - nextHp;
        const burstIncrease = (damage / player.unit.maxHp) * 110; // 被ダメージによる覚醒ゲージ増加レート
        player.hp = nextHp;
        player.burstGauge = clampValue(player.burstGauge + burstIncrease, 0, 200);
        return;
    }
    if (field === "burstGauge") {
        player.burstGauge = clampValue(value, 0, 200);
        return;
    }
}
/**
 * 【機能】プレイヤーの機体をプルダウンで任意に変更する
 * 【何のために】機体変更時、4機の間での機体重複を防ぎ（重複時はアラートを出して戻す）、正常な場合は最大HPや現在HP、チームコストへの影響を再計算するため
 */
function updatePlayerUnit(playerKey, unitName) {
    if (currentSituation === null)
        return;
    const selectedUnit = units.find((unit) => unit.name === unitName);
    if (selectedUnit === undefined)
        return;
    // 他のプレイヤーと機体が重複していないかチェック
    const playerKeys = ["self", "partner", "enemy1", "enemy2"];
    const isDuplicate = playerKeys.some((key) => {
        if (key === key || currentSituation === null)
            return false;
        return currentSituation[key].unit.name === selectedUnit.name;
    });
    if (isDuplicate) {
        alert(ERROR_MESSAGES.duplicateUnit);
        renderCurrentSituation();
        return;
    }
    const player = currentSituation[playerKey];
    player.unit = selectedUnit;
    player.currentMaxHp = selectedUnit.maxHp;
    player.hp = clampValue(player.hp, 1, selectedUnit.maxHp);
    recalculateTeamCosts(playerKey);
}
/**
 * 【機能】オーバーリミットの状態を手動で更新する
 * 【何のために】プルダウンメニューで選択された「未使用/利用可能/終了」の状態を直接内部データへ書き込むため
 */
function updateOverLimitStatus(playerKey, status) {
    if (currentSituation === null)
        return;
    currentSituation[playerKey].overLimitStatus = status;
}
/**
 * 【機能】プレイヤーのステータスを対戦開始前のクリーンな初期状態にリセットする
 * 【何のために】「初期表示」ボタンが押された際、全プレイヤーを一律リセットするため
 */
function resetPlayerToInitialState(player) {
    player.currentMaxHp = player.unit.maxHp;
    player.hp = player.unit.maxHp;
    player.deaths = 0;
    player.partnerDeaths = 0;
    player.dealtDamage = 0;
    player.burstGauge = 0;
    player.overLimitStatus = "unused";
}
/** ==========================================
 * 7. レンダリング・画面表示制御
 * 【目的】内部データを実際のブラウザ画面に描画・反映するため
 * ========================================== */
/**
 * 【機能】初期状態の戦況（全員無傷・コスト6000満タン）を強制的に作成し、画面を描画する
 * 【何のために】「初期表示」ボタン押下時に、現在の機体編成のままゲーム開始時点のシチュエーションを再現するため
 */
function renderInitialSituation() {
    if (currentSituation === null) {
        currentSituation = createSituation();
    }
    currentSituation.allyTeamCost = 6000;
    currentSituation.enemyTeamCost = 6000;
    resetPlayerToInitialState(currentSituation.self);
    resetPlayerToInitialState(currentSituation.partner);
    resetPlayerToInitialState(currentSituation.enemy1);
    resetPlayerToInitialState(currentSituation.enemy2);
    syncPartnerDeaths();
    renderCurrentSituation();
}
/**
 * 【機能】現在の `currentSituation` データを元に、最新 of HTML画面を再構築して再描画する
 * 【何のために】データのあらゆる変化（HP増減、コスト変化など）を、漏れなくWeb画面上のメーターや数値テキストへ反映させ、操作用のイベントを再バインドするため
 */
function renderCurrentSituation() {
    if (currentSituation === null)
        return;
    const teamStatusOutput = getRequiredElementById("team-status-output", ERROR_MESSAGES.teamStatusOutputNotFound);
    const output = getRequiredElementById("situation-output", ERROR_MESSAGES.situationOutputNotFound);
    clearElement(teamStatusOutput);
    clearElement(output);
    // チームコストエリアとプレイヤーカードエリアをHTMLに結合
    teamStatusOutput.appendChild(createTeamStatusElement(currentSituation));
    output.appendChild(createSituationFragment(currentSituation));
    // マップ上の各要素（ピン、矢印）の位置を再描画・更新
    updateAllMapElements();
    // 描画された新しいHTML要素たちに操作イベントを紐付け直す
    setupCardEvents();
}
/** ==========================================
 * 8. イベントリスナー・ユーザー操作検知
 * 【目的】画面上のボタンクリックや入力変更を検知して、関数を動かすため
 * ========================================== */
/**
 * 【機能】画面内の全操作パーツ（カード内UI、マップ内ドラッグ、表示切り替えパネル）のイベント設定を一括で行う
 * 【何のために】再レンダリング直後にすべての入力操作が正しく機能するようにするため
 */
function setupCardEvents() {
    setupAdjustInputEvents();
    setupAdjustButtonEvents();
    setupUnitCardSelectEvents();
    setupOverLimitSelectEvents();
    setupMapDragEvents(); // マップ上のピン移動＆矢印コントロールイベントを紐付け
    setupArrowToggleEvents(); // 追加：矢印のON/OFF切り替えパネルのイベントを紐付け
}
/**
 * 【機能】テキストボックス数値の手動直接入力を検知するイベントを設定する
 * 【何のために】ユーザーがキーボード等で直接「撃墜数」や「与ダメージ」を書き換えた際、その値を検知してデータに反映・再描画するため
 */
function setupAdjustInputEvents() {
    const adjustInputs = document.querySelectorAll(".adjust-input");
    adjustInputs.forEach((input) => {
        if (!(input instanceof HTMLInputElement))
            return;
        input.addEventListener("change", () => {
            const playerKey = input.dataset.playerKey;
            const field = input.dataset.field;
            const value = Number(input.value);
            if (!isPlayerKey(playerKey) || !isAdjustableField(field))
                return;
            updatePlayerField(playerKey, field, value);
            renderCurrentSituation();
        });
    });
}
/**
 * 【機能】調整ボタン（＋ / ー）のポインターダウン（長押し対応）イベントを設定する
 * 【何のために】ボタンを押し続けている間、150ms間隔で自動的に数値を連続増減させ（HPやダメージなら10刻み、その他は1刻み）、指が離れたり画面がボケた（blur）際に安全にタイマーを停止させる心地よい操作性を実現するため
 */
function setupAdjustButtonEvents() {
    const adjustButtons = document.querySelectorAll(".adjust-button");
    adjustButtons.forEach((button) => {
        if (!(button instanceof HTMLButtonElement))
            return;
        // 1回分の増減を実行する内部処理
        const updateValue = () => {
            const playerKey = button.dataset.playerKey;
            const field = button.dataset.field;
            const direction = Number(button.dataset.direction); // +1 または -1
            if (!isPlayerKey(playerKey) || !isAdjustableField(field) || currentSituation === null) {
                stopAdjustButtonRepeat();
                return;
            }
            const player = currentSituation[playerKey];
            const currentValue = player[field];
            const step = field === "dealtDamage" || field === "hp" || field === "burstGauge" ? 10 : 1;
            const nextValue = currentValue + direction * step;
            updatePlayerField(playerKey, field, nextValue);
            renderCurrentSituation();
        };
        // マウスやタッチが押し込まれた際の長押し処理スタート
        const startRepeat = (event) => {
            event.preventDefault();
            stopAdjustButtonRepeat(); // 二重起動防止
            updateValue(); // まず1回即座に実行
            // 以降、150ミリ秒ごとに連続実行
            adjustButtonRepeatTimerId = window.setInterval(() => {
                updateValue();
            }, 150);
            // 指が離れた、キャンセルされた、ブラウザタブが切り替わった等のイベントで安全に停止させる
            window.addEventListener("pointerup", stopAdjustButtonRepeat, { once: true });
            window.addEventListener("pointercancel", stopAdjustButtonRepeat, { once: true });
            window.addEventListener("blur", stopAdjustButtonRepeat, { once: true });
        };
        button.addEventListener("pointerdown", startRepeat);
    });
}
/**
 * 【機能】機体選択用セレクトボックスの変更イベントを設定する
 * 【何のために】ユーザーがプルダウンから別の機体を選んだ際、内部データをその機体情報に切り替えて再計算・再描画するため
 */
function setupUnitCardSelectEvents() {
    const unitSelects = document.querySelectorAll(".unit-card-select");
    unitSelects.forEach((select) => {
        if (!(select instanceof HTMLSelectElement))
            return;
        select.addEventListener("change", () => {
            const playerKey = select.dataset.playerKey;
            if (!isPlayerKey(playerKey))
                return;
            updatePlayerUnit(playerKey, select.value);
            renderCurrentSituation();
        });
    });
}
/**
 * 【機能】オーバーリミット選択セレクトボックスの変更イベントを設定する
 * 【何のために】手動でオーバーリミットステータスが切り替えられた際、内部データを同期して再描画するため
 */
function setupOverLimitSelectEvents() {
    const overLimitSelects = document.querySelectorAll(".over-limit-select");
    overLimitSelects.forEach((select) => {
        if (!(select instanceof HTMLSelectElement))
            return;
        select.addEventListener("change", () => {
            const playerKey = select.dataset.playerKey;
            const value = select.value;
            if (!isPlayerKey(playerKey) || !isOverLimitStatus(value))
                return;
            updateOverLimitStatus(playerKey, value);
            renderCurrentSituation();
        });
    });
}
/**
 * 【機能】内部の座標データ(`mapPositions`)をベースに、HTML要素(ピン・矢印・ターゲット)を全て同期描画する
 * 【何のために】ピン単体の移動時、または矢印単体の変形時に、それぞれの位置や表示・非表示の辻褄がバラバラに壊れないよう一律制御するため
 */
/**
 * 【機能】内部の座標データ(`mapPositions`)をベースに、HTML要素(ピン・矢印・ターゲット)を全て同期描画する
 * 【何のために】ピン単体の移動時、または矢印単体の変形時に、それぞれの位置や表示・非表示の辻褄がバラバラに壊れないよう一律制御するため
 */
function updateAllMapElements() {
    const keys = ["self", "partner", "enemy1", "enemy2"];
    keys.forEach((key) => {
        const pos = mapPositions[key];
        // 1. ピン本体の位置の更新
        const pin = document.querySelector(`.map-pin[data-player-key="${key}"]`);
        if (pin instanceof HTMLElement) {
            pin.style.left = `${pos.x}%`;
            pin.style.top = `${pos.y}%`;
        }
        // 2-A. 追加：下地になる太い白フチ線の位置と表示ON/OFF更新
        const bgLine = document.getElementById(`arrow-line-${key}-bg`);
        if (bgLine instanceof SVGLineElement) {
            bgLine.setAttribute("x1", `${pos.x}%`);
            bgLine.setAttribute("y1", `${pos.y}%`);
            bgLine.setAttribute("x2", `${pos.x + pos.vx}%`);
            bgLine.setAttribute("y2", `${pos.y + pos.vy}%`);
            bgLine.style.display = pos.visible ? "block" : "none";
        }
        // 2-B. SVGカラー線の位置と表示ON/OFF更新
        const line = document.getElementById(`arrow-line-${key}`);
        if (line instanceof SVGLineElement) {
            line.setAttribute("x1", `${pos.x}%`);
            line.setAttribute("y1", `${pos.y}%`);
            line.setAttribute("x2", `${pos.x + pos.vx}%`);
            line.setAttribute("y2", `${pos.y + pos.vy}%`);
            line.style.display = pos.visible ? "block" : "none";
        }
        // 3. 矢印先端をいじる調整ターゲット（つまみ）の位置と表示ON/OFF更新
        const target = document.querySelector(`.arrow-target[data-target-key="${key}"]`);
        if (target instanceof HTMLElement) {
            target.style.left = `${pos.x + pos.vx}%`;
            target.style.top = `${pos.y + pos.vy}%`;
            target.style.display = pos.visible ? "block" : "none";
        }
    });
}
/**
 * 【機能】マップ上の各ピン（○）および「伸縮・角度調整用の矢印つまみ」にドラッグ用PointerEventsを設定する
 * 【何のために】ピンを動かしたら矢印の根本も追従し、先端のつまみをドラッグしたら矢印が伸び縮み・旋回(角度調整)できるようにするため
 */
function setupMapDragEvents() {
    const container = document.getElementById("map-container");
    if (!container)
        return;
    // --- パターンA: ピン（○）自体の移動制御 ---
    const pins = document.querySelectorAll(".map-pin");
    pins.forEach((pin) => {
        if (!(pin instanceof HTMLElement))
            return;
        pin.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            const key = pin.dataset.playerKey;
            if (!isPlayerKey(key))
                return;
            pin.setPointerCapture(event.pointerId);
            const onPointerMove = (moveEvent) => {
                const rect = container.getBoundingClientRect();
                const xPercent = Math.min(100, Math.max(0, ((moveEvent.clientX - rect.left) / rect.width) * 100));
                const yPercent = Math.min(100, Math.max(0, ((moveEvent.clientY - rect.top) / rect.height) * 100));
                mapPositions[key].x = xPercent;
                mapPositions[key].y = yPercent;
                updateAllMapElements();
            };
            const onPointerUp = (upEvent) => {
                pin.releasePointerCapture(upEvent.pointerId);
                container.removeEventListener("pointermove", onPointerMove);
                container.removeEventListener("pointerup", onPointerUp);
            };
            container.addEventListener("pointermove", onPointerMove);
            container.addEventListener("pointerup", onPointerUp);
        });
    });
    // --- パターンB: 矢印先端のターゲット（つまみ）による伸縮・角度調整制御 ---
    const targets = document.querySelectorAll(".arrow-target");
    targets.forEach((target) => {
        if (!(target instanceof HTMLElement))
            return;
        target.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            const key = target.dataset.targetKey;
            if (!isPlayerKey(key))
                return;
            target.setPointerCapture(event.pointerId);
            const onPointerMove = (moveEvent) => {
                const rect = container.getBoundingClientRect();
                const currentXPercent = ((moveEvent.clientX - rect.left) / rect.width) * 100;
                const currentYPercent = ((moveEvent.clientY - rect.top) / rect.height) * 100;
                const basePos = mapPositions[key];
                let vx = currentXPercent - basePos.x;
                let vy = currentYPercent - basePos.y;
                const length = Math.sqrt(vx * vx + vy * vy);
                const minLength = 4;
                const maxLength = 35;
                if (length < minLength) {
                    vx = length === 0 ? 0 : (vx / length) * minLength;
                    vy = length === 0 ? minLength : (vy / length) * minLength;
                }
                else if (length > maxLength) {
                    vx = (vx / length) * maxLength;
                    vy = (vy / length) * maxLength;
                }
                mapPositions[key].vx = vx;
                mapPositions[key].vy = vy;
                updateAllMapElements();
            };
            const onPointerUp = (upEvent) => {
                target.releasePointerCapture(upEvent.pointerId);
                container.removeEventListener("pointermove", onPointerMove);
                container.removeEventListener("pointerup", onPointerUp);
            };
            container.addEventListener("pointermove", onPointerMove);
            container.addEventListener("pointerup", onPointerUp);
        });
    });
}
/**
 * 【機能】操作パネル内にあるチェックボックスのイベントを設定する
 * 【何のために】チェックボックスのON/OFFが切り替わったタイミングで、データ(`mapPositions.visible`)を書き換え、マップを再描画するため
 */
function setupArrowToggleEvents() {
    const checkboxes = document.querySelectorAll(".arrow-toggle-checkbox");
    checkboxes.forEach((checkbox) => {
        if (!(checkbox instanceof HTMLInputElement))
            return;
        // 現在のデータの状態に合わせてチェックボックスの初期状態を同期
        const key = checkbox.dataset.targetArrow;
        if (isPlayerKey(key)) {
            checkbox.checked = mapPositions[key].visible;
        }
        // 切り替えイベントの登録
        checkbox.addEventListener("change", () => {
            if (isPlayerKey(key)) {
                mapPositions[key].visible = checkbox.checked;
                updateAllMapElements(); // 画面に即座に反映
            }
        });
    });
}
/** ==========================================
 * 9. 型ガード（Type Guard）関数
 * 【目的】HTMLのdata属性(unknown)から取得した文字列が、定義した型と合致するか安全にランタイムチェックするため
 * ========================================== */
function isPlayerKey(value) {
    return value === "self" || value === "partner" || value === "enemy1" || value === "enemy2";
}
function isAdjustableField(value) {
    return value === "deaths" || value === "partnerDeaths" || value === "dealtDamage" || value === "hp" || value === "burstGauge";
}
function isOverLimitStatus(value) {
    return value === "available" || value === "unused" || value === "ended";
}
/** ==========================================
 * 10. エラーハンドリングと初期起動処理
 * 【目的】アプリケーションの起動、エラー画面表示、大元のボタンへのバインド
 * ========================================== */
/**
 * 【機能】システムエラー用のカード要素（HTML）を生成する
 * 【何のために】予期せぬエラーやバリデーション違反が発生した際、画面をクラッシュさせずにユーザーへエラーメッセージをカード形式で綺麗に提示するため
 */
function createErrorElement(errorMessage) {
    const section = document.createElement("section");
    section.classList.add("card", "error-card");
    const heading = document.createElement("h2");
    heading.textContent = "エラー";
    const paragraph = document.createElement("p");
    paragraph.textContent = errorMessage;
    section.appendChild(heading);
    section.appendChild(paragraph);
    return section;
}
/**
 * 【機能】新しくランダム戦況を生成して画面全体をレンダリングする
 * 【何のために】「ランダム生成」ボタンが押されたとき、またはアプリが一番最初に起動したときに、一から正常な戦況画面を作り出すため（例外発生時は上記のエラー表示へ切り替える）
 */
function renderSituation() {
    const teamStatusOutput = getRequiredElementById("team-status-output", ERROR_MESSAGES.teamStatusOutputNotFound);
    const output = getRequiredElementById("situation-output", ERROR_MESSAGES.situationOutputNotFound);
    try {
        currentSituation = createSituation(); // 新規戦況データ生成
        clearElement(teamStatusOutput);
        clearElement(output);
        teamStatusOutput.appendChild(createTeamStatusElement(currentSituation));
        output.appendChild(createSituationFragment(currentSituation));
        setupCardEvents();
    }
    catch (error) {
        currentSituation = null;
        clearElement(teamStatusOutput);
        clearElement(output);
        const errorMessage = error instanceof Error ? error.message : ERROR_MESSAGES.unknown;
        output.appendChild(createErrorElement(errorMessage)); // エラー画面の表示
    }
}
/**
 * 【アプリケーションのエントリーポイント（起動処理）】
 * 画面上の「初期表示」ボタン・「ランダム生成」ボタンを取得し、クリックイベントを登録後、初回起動としての描画を走らせる
 */
const initialButton = document.getElementById("initial-button");
if (!(initialButton instanceof HTMLButtonElement)) {
    throw new Error("初期表示ボタンが見つかりません");
}
const generateButton = document.getElementById("generate-button");
if (!(generateButton instanceof HTMLButtonElement)) {
    throw new Error(ERROR_MESSAGES.generateButtonNotFound);
}
// 各種大元ボタンのクリックスリッサー登録
initialButton.addEventListener("click", () => {
    renderInitialSituation();
});
generateButton.addEventListener("click", () => {
    renderSituation();
});
// ファイルが読み込まれた際、最初に1回自動でランダム戦況を描画する
renderSituation();
//# sourceMappingURL=situation.js.map