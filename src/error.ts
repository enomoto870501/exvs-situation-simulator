export const ERROR_MESSAGES = {
    emptyArray: "配列が空です",
    randomSelectFailed: "ランダム選択に失敗しました",
    unitSelectFailed: "機体選択に失敗しました",
    unitCountExceeded: "選択数が機体数を超えています",
  
    selfUnitNotFound: "選択された自分機体が見つかりません",
    partnerUnitNotFound: "選択された僚機が見つかりません",
    enemy1UnitNotFound: "選択された敵機1が見つかりません",
    enemy2UnitNotFound: "選択された敵機2が見つかりません",
  
    duplicateUnit: "同じ機体を複数の枠に選択することはできません",
    requiredUnitsNotSelected: "必要な機体数を選択できませんでした",
  
    teamStatusOutputNotFound: "チーム状況の表示先が見つかりません",
    situationOutputNotFound: "表示先の要素が見つかりません",
  
    generateButtonNotFound: "再生成ボタンが見つかりません",
    selfUnitSelectNotFound: "自分機体の選択欄が見つかりません",
    partnerUnitSelectNotFound: "僚機の選択欄が見つかりません",
    enemy1UnitSelectNotFound: "敵機1の選択欄が見つかりません",
    enemy2UnitSelectNotFound: "敵機2の選択欄が見つかりません",
  
    unknown: "不明なエラーが発生しました。",
  } as const;