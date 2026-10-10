-- =====================================================================
-- seed_fitora_local.sql — Fitora demo data for ONE local e2e account.
--
-- NOT a migration; never run by `db push` / `db reset` (config.toml sql_paths).
-- Used by Fitora/e2e (global setup) against the LOCAL stack only:
--     select set_config('app.fit_email', '<email>', true);  -- same transaction
--     \i seed_fitora_local.sql
--
-- Safety: refuses any account whose raw_app_meta_data lacks "fitora_e2e": true,
-- so a real user's data can never be wiped. Re-runnable: the account's fit_*
-- rows are deleted and rebuilt. Rows owned by Note_mytasks (profiles, tasks, …)
-- are not touched. Dates are relative to "today" in Asia/Ho_Chi_Minh.
--
-- Persona: male, born 1995-05-10, 172 cm, moderate activity, goal "lose"
-- (medium pace) 78 → 70 kg, 2000 kcal · P156 / C200 / F62, 14 days of history.
-- =====================================================================

do $$
declare
  v_email text := nullif(current_setting('app.fit_email', true), '');
  v_uid   uuid;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_food  uuid;
  v_tpl   uuid;
  d       integer;
  v_day   date;
begin
  if v_email is null then
    raise exception 'set app.fit_email first';
  end if;
  select u.id into v_uid from auth.users u
   where lower(u.email) = lower(v_email)
     and coalesce((u.raw_app_meta_data ->> 'fitora_e2e')::boolean, false);
  if v_uid is null then
    raise exception 'no e2e account % (needs raw_app_meta_data.fitora_e2e = true)', v_email;
  end if;

  delete from public.fit_meal_entries      where user_id = v_uid;
  delete from public.fit_workouts          where user_id = v_uid;
  delete from public.fit_workout_templates where user_id = v_uid;
  delete from public.fit_custom_foods      where user_id = v_uid;
  delete from public.fit_daily_logs        where user_id = v_uid;
  delete from public.fit_body_measurements where user_id = v_uid;
  delete from public.fit_progress_photos   where user_id = v_uid;
  delete from public.fit_ai_usage          where user_id = v_uid;
  delete from public.fit_profiles          where user_id = v_uid;

  insert into public.fit_profiles (user_id, sex, birth_date, height_cm, activity_level, goal, goal_pace,
    start_weight_kg, target_weight_kg, calorie_target, protein_g, carbs_g, fat_g, macro_custom,
    water_target_ml, step_target, onboarded_at)
  values (v_uid, 'male', date '1995-05-10', 172, 'moderate', 'lose', 'medium',
    78, 70, 2000, 156, 200, 62, false, 2500, 8000, now() - interval '14 days');

  insert into public.fit_custom_foods (user_id, name, brand, serving_label, serving_grams,
    kcal_100g, protein_100g, carbs_100g, fat_100g, fiber_100g)
  values (v_uid, 'Sữa chua Hy Lạp nhà làm', null, '1 hũ', 150, 97, 9, 4, 5, 0)
  returning id into v_food;

  insert into public.fit_workout_templates (user_id, name, category, activity, met, duration_min, notes)
  values (v_uid, 'Đẩy ngực – vai', 'gym', 'weight_training', 5.0, 60, 'Bench, OHP, dips')
  returning id into v_tpl;

  for d in 0..13 loop
    v_day := v_today - d;

    -- Three meals a day (today: breakfast + lunch only, so "remaining" is visible).
    insert into public.fit_meal_entries (user_id, eaten_on, meal, name, quantity, unit, grams,
      kcal, protein_g, carbs_g, fat_g, fiber_g, source)
    values
      (v_uid, v_day, 'breakfast', 'Phở bò', 1, 'bát', 500, 450, 25, 55, 12, 2, 'search'),
      (v_uid, v_day, 'lunch', 'Cơm gà xối mỡ', 1, 'đĩa', 400, 650, 35, 70, 24, 2, 'search');
    if d > 0 then
      insert into public.fit_meal_entries (user_id, eaten_on, meal, name, quantity, unit, grams,
        kcal, protein_g, carbs_g, fat_g, fiber_g, source)
      values (v_uid, v_day, 'dinner', 'Ức gà luộc + rau', 1, 'phần', 350, 420 + (d % 3) * 60, 48, 20, 10, 6, 'manual');
    end if;
    if d % 2 = 0 then
      insert into public.fit_meal_entries (user_id, eaten_on, meal, name, quantity, unit, grams,
        kcal, protein_g, carbs_g, fat_g, fiber_g, source, custom_food_id)
      values (v_uid, v_day, 'snack', 'Sữa chua Hy Lạp nhà làm', 1, 'hũ', 150, 145.5, 13.5, 6, 7.5, 0, 'custom', v_food);
    end if;

    -- Workouts: gym Mon/Wed/Fri-ish, a run every 3rd day.
    if d % 2 = 1 then
      insert into public.fit_workouts (user_id, workout_on, start_time, category, activity, title, met,
        duration_min, kcal, status, template_id)
      values (v_uid, v_day, time '18:00', 'gym', 'weight_training', 'Đẩy ngực – vai', 5.0, 60, 410, 'done', v_tpl);
    end if;
    if d % 3 = 0 and d > 0 then
      insert into public.fit_workouts (user_id, workout_on, start_time, category, activity, title, met,
        duration_min, kcal, status)
      values (v_uid, v_day, time '06:00', 'running', 'running_8kmh', 'Chạy bộ 5 km', 8.3, 35, 380, 'done');
    end if;

    insert into public.fit_daily_logs (user_id, log_date, water_ml, steps)
    values (v_uid, v_day, case when d = 0 then 750 else 1750 + (d % 4) * 250 end,
                          case when d = 0 then 3200 else 6000 + (d % 5) * 900 end);

    if d % 2 = 0 then
      insert into public.fit_body_measurements (user_id, measured_on, weight_kg, waist_cm)
      values (v_uid, v_day, 76.6 + d * 0.1, case when d % 4 = 0 then 86 + d * 0.1 end);
    end if;
  end loop;

  -- A planned session tomorrow (must NOT count as burned).
  insert into public.fit_workouts (user_id, workout_on, start_time, category, activity, title, met,
    duration_min, kcal, status)
  values (v_uid, v_today + 1, time '07:00', 'yoga', 'yoga', 'Yoga buổi sáng', 2.5, 45, 140, 'planned');
end;
$$;
