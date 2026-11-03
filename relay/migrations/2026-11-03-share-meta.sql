-- QR ULTRA-LÉGER (mission appairage) : la copie de la boutique et la clé publique du
-- principal sont frappées au mint (colonne meta) et rendues au redeem — le QR ne
-- transporte plus que le jeton + le code de paire (un QR dense se refuse au scan).
ALTER TABLE share_tokens ADD COLUMN IF NOT EXISTS meta TEXT;
